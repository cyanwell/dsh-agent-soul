import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-qzone-delete-'))

const { createQzone } = await import('../src/aurabot/src/features/qzone.js')
const { createQzoneSocial } = await import('../src/aurabot/src/features/qzone-social.js')
const { createOutboxGateway, OutboxGatewayError } = await import('../src/aurabot/adapter/outbox-gateway.mjs')
const { ACT_ACTIONS } = await import('../src/adapters/outbox.mjs')
const { dataDir } = await import('../src/aurabot/src/core/store.js')
import { readFileSync, writeFileSync, rmSync } from 'node:fs'

function makeQzone(config, onebot = null) {
  const calls = []
  const qzone = createQzone({
    getConfig: () => config,
    onebot: onebot || { call: async (action, params) => { calls.push({ action, params }); return { deleted: true } } },
    hub: {},
    log: { info() {}, warn() {}, debug() {} },
  })
  return { qzone, calls }
}

// ── 出站口那一路（2026-11-24 第五片）：delete_qzone_msg 是**唯一**迁走的 Qzone 动作 ──
// ★ 这个文件里的每一条都只打假 outbox / 假 client：不连网关、不读部署配置、不留真数据。
const diaryFile = () => dataDir('diary.json')
const readDiary = () => JSON.parse(readFileSync(diaryFile(), 'utf8'))
const seedDiary = (rows) => writeFileSync(diaryFile(), JSON.stringify(rows, null, 2), 'utf8')

/** 假出站口：只记账，不连网。actResult 可以是值，也可以是函数。 */
function fakeOutbox({ actResult = { ok: true, retcode: 0, data: null } } = {}) {
  const acts = []
  const sends = []
  return {
    acts,
    sends,
    act: async (action, params, opts) => {
      acts.push({ action, params, opts })
      return typeof actResult === 'function' ? actResult(action, params, opts) : actResult
    },
    send: async (chatId, segments, opts) => { sends.push({ chatId, segments, opts }); return { ok: true, retcode: 0, messageId: 1 } },
    poke: async () => ({ ok: true, retcode: 0 }),
  }
}

/** 假 OneBot client：只记账。任何落在这里的动作 = 没迁走的动作。 */
function fakeClient() {
  const calls = []
  return { calls, state: 'connected', call: async (action, params, opts) => { calls.push({ action, params, opts }); return { from: 'client' } } }
}

test('Qzone delete is blocked when disabled or in dryRun', async () => {
  for (const config of [{ enabled: false, dryRun: false }, { enabled: true, dryRun: true }]) {
    const { qzone, calls } = makeQzone(config)
    const result = await qzone.remove('post-1')
    assert.equal(result.ok, false)
    assert.equal(result.code, config.enabled ? 'dry-run' : 'disabled')
    assert.deepEqual(calls, [])
  }
})

test('Qzone delete calls OneBot only when enabled and not dryRun', async () => {
  const { qzone, calls } = makeQzone({ enabled: true, dryRun: false })
  const result = await qzone.remove(' post-2 ')
  assert.deepEqual(calls, [{ action: 'delete_qzone_msg', params: { tid: 'post-2' } }])
  assert.deepEqual(result, { deleted: true })
})

// ────────────────────────────────────────────────────────────────────────────
// ⑤ 迁移后的那一手：delete_qzone_msg 改道走 outbox.act（**只有它一个**）。
//
// 要钉死的五件事：
//   ① { tid } 逐字到 outbox.act（同一份参数；上游已 trim，这一层不再动一个字符）；
//   ② 出站口回 {ok:false} → 抛 OutboxGatewayError → **本地 history 的 deletedAt 不写**；
//   ③ enabled=false / dryRun → 在**出站口之前**就返回 {ok:false}（act 一次都没调）；
//   ④ mode=off / 没有出站口 → 拒绝，**不回落旧 client**（fetch / client 都是 0 次）；
//   ⑤ Qzone 发说说 / 评论 / 点赞都已在白名单里（点赞是第八片迁的）。
// ────────────────────────────────────────────────────────────────────────────

test('Qzone 四个动作都在 ACT_ACTIONS 里；like_qzone 由第八片迁入', () => {
  assert.equal(ACT_ACTIONS.includes('delete_qzone_msg'), true)
  assert.equal(ACT_ACTIONS.includes('send_qzone_msg'), true, '只追加发布动作')
  assert.equal(ACT_ACTIONS.includes('comment_qzone'), true)
  // ★ 第八片（2026-11-24）：点赞也是**用户明确授权**才进来的，不是顺手带的。
  assert.equal(ACT_ACTIONS.includes('like_qzone'), true, 'like_qzone 已在第八片迁入')
  // ★ 反向的一半：近似串仍然必须在外面（名字逐字相等）。
  for (const name of ['Like_Qzone', 'like_qzone_extra', 'like_qzone_msg']) {
    assert.equal(ACT_ACTIONS.includes(name), false, name + ' 不许被当成白名单名字')
  }
})

test('⑤ { tid } 逐字落到 outbox.act（同一个对象 / 30s 默认 / 无幂等键 / 没打真 client）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gateway = createOutboxGateway({ client, outbox })
  const { qzone } = makeQzone({ enabled: true, dryRun: false }, gateway)

  const result = await qzone.remove(' post-2 ')

  assert.equal(outbox.acts.length, 1, '只该有一次 outbox.act')
  const rec = outbox.acts[0]
  assert.equal(rec.action, 'delete_qzone_msg')
  assert.deepEqual(rec.params, { tid: 'post-2' }, '上游 trim 过的那一个 tid 原样交出（这一层不再 trim / 不再归一）')
  assert.equal(Object.keys(rec.params).length, 1, '参数只有 tid 一个字段（不多塞）')
  assert.equal(rec.opts.timeoutMs, 30000, '不给 timeoutMs → 30s（OneBot client 的默认，不是出站口的 8s）')
  assert.equal('idempotencyKey' in rec.opts, false, '删除不挂摘要幂等')
  assert.equal(client.calls.length, 0, '迁移过的动作不许再打真 client')
  assert.equal(outbox.sends.length, 0, '删除不是发消息')
  assert.deepEqual(result, null, '成功时交回 outbox 的 data 原件（这里是 null）')
})

test('⑤ 出站口回 {ok:false} → 抛 OutboxGatewayError，本地 history **不写 deletedAt**（最要紧的一条）', async () => {
  seedDiary({ plan: { day: '', times: [], done: [] }, history: [
    { tid: 'post-2', ok: true, at: 1, content: '第一条' },
    { tid: 'post-other', ok: true, at: 2, content: '别的一条' },
  ] })
  const before = readDiary()

  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: false, retcode: 100, error: '网关说 tid 无效' } })
  const gateway = createOutboxGateway({ client, outbox })
  const { qzone } = makeQzone({ enabled: true, dryRun: false }, gateway)

  let caught = null
  try { await qzone.remove('post-2') } catch (error) { caught = error }

  // ① 失败必须显式地是出站口的拒绝（不是静默成功、不是别的形状）
  assert.equal(caught instanceof OutboxGatewayError, true, '失败必须抛 OutboxGatewayError（不是静默成功）')
  assert.equal(caught.code, 'outbox-rejected')
  assert.equal(caught.action, 'delete_qzone_msg')
  assert.equal(caught.retcode, 100)
  assert.equal(caught.transport, false, '重试会真的再删一次，不许被当成「可重连再试」')
  assert.match(caught.message, /tid 无效/)

  // ② 本地记录**一个字节都没变** —— 这是本条测试的全部意义
  const after = readDiary()
  assert.deepEqual(after, before, '删除失败了，diary.json 必须逐字节不变（尤其 deletedAt 不许被写上）')
  for (const entry of after.history) {
    assert.equal('deletedAt' in entry, false, '失败路径不许给任何一条写 deletedAt（' + entry.tid + '）')
  }

  assert.equal(client.calls.length, 0, '失败也不回落旧 client（那等于删两次）')
  assert.equal(outbox.acts.length, 1, '只发了一次删除请求')
  rmSync(diaryFile(), { force: true })
})

test('⑤ 出站口回 ok:true → 只有那一条被标 deletedAt，另一条不动（成功路径的反向对照）', async () => {
  seedDiary({ plan: { day: '', times: [], done: [] }, history: [
    { tid: 'post-2', ok: true, at: 1, content: '第一条' },
    { tid: 'post-other', ok: true, at: 2, content: '别的一条' },
  ] })
  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: { ok: true, retcode: 0, data: { tid: 'post-2' } } })
  const gateway = createOutboxGateway({ client, outbox })
  const { qzone } = makeQzone({ enabled: true, dryRun: false }, gateway)

  const result = await qzone.remove('post-2')
  const after = readDiary()

  const hit = after.history.find((e) => e.tid === 'post-2')
  const other = after.history.find((e) => e.tid === 'post-other')
  assert.equal(typeof hit.deletedAt, 'number', '成功才写 deletedAt')
  assert.equal('deletedAt' in other, false, '别的一条不许被连带标删')
  assert.deepEqual(result, { tid: 'post-2' }, '交回 outbox 的 data 原件')
  assert.equal(client.calls.length, 0)
  rmSync(diaryFile(), { force: true })
})

test('⑤ disabled / dryRun：在出站口**之前**就返回 {ok:false}，outbox.act 一次都没调', async () => {
  for (const [config, code] of [[{ enabled: false, dryRun: false }, 'disabled'], [{ enabled: true, dryRun: true }, 'dry-run']]) {
    const client = fakeClient()
    const outbox = fakeOutbox()
    const gateway = createOutboxGateway({ client, outbox })
    const { qzone } = makeQzone(config, gateway)

    const result = await qzone.remove('post-1')
    assert.equal(result.ok, false, JSON.stringify(config) + ' 必须拒')
    assert.equal(result.code, code)
    assert.equal(outbox.acts.length, 0, '闸在上游：这种情况下一次 outbox.act 都不许有')
    assert.equal(client.calls.length, 0)
  }
})

test('⑤ 空 tid：在上游就抛（出站口一次都没调，连 act 都不进）', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gateway = createOutboxGateway({ client, outbox })
  const { qzone } = makeQzone({ enabled: true, dryRun: false }, gateway)

  for (const bad of ['', '   ', null, undefined]) {
    let caught = null
    try { await qzone.remove(bad) } catch (error) { caught = error }
    assert.equal(caught instanceof Error, true, JSON.stringify(bad) + ' 必须抛')
    assert.match(caught.message, /说说 ID/)
    assert.equal(outbox.acts.length, 0, '空 tid 走不到出站口')
  }
})

test('⑤ mode=off / 没有出站口：delete_qzone_msg 拒绝（outbox-unavailable），不回落旧 client', async () => {
  // mode=off：照 core 的装配顺序 —— 选择 → 网关拿到 null
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gateway = createOutboxGateway({ client, outbox: null, getOutbox: () => null })
  const { qzone } = makeQzone({ enabled: true, dryRun: false }, gateway)

  let caught = null
  try { await qzone.remove('post-9') } catch (error) { caught = error }
  assert.equal(caught instanceof OutboxGatewayError, true, '没有出站口必须拒绝')
  assert.equal(caught.code, 'outbox-unavailable')
  assert.equal(caught.action, 'delete_qzone_msg')
  assert.match(caught.message, /不回落/)
  assert.equal(client.calls.length, 0, '不许回落到 OneBot client')
  assert.equal(outbox.acts.length, 0)
})

test('⑧ Qzone like_qzone 现在走 outbox.act：参数原样、一次、不挂幂等、不打真 client', async () => {
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gateway = createOutboxGateway({ client, outbox })

  const params = { tid: 'post-1', target_uin: 200, abstime: 1732530000 }
  await gateway.call('like_qzone', params, { timeoutMs: 20000 })

  assert.equal(outbox.acts.length, 1, '点赞正好一次 outbox.act')
  const rec = outbox.acts[0]
  assert.equal(rec.action, 'like_qzone')
  assert.equal(rec.params, params, 'params 是同一个对象（tid / target_uin / abstime 一个字符都不动）')
  assert.equal(rec.opts.timeoutMs, 20000, 'qzone-social 给的 20000 原样往下（不压回 30s）')
  assert.equal('idempotencyKey' in rec.opts, false, '点赞不挂幂等键')
  assert.equal(client.calls.length, 0, '迁移过的动作不许再打真 client')
})

test('⑤ 出站口**抛错**（不是回 {ok:false}）→ 本地 history 同样不写 deletedAt', async () => {
  // ★ 与上一条不是重复：{ok:false} 是**业务拒绝**，抛错是**契约外的错**（网络层炸了、
  //   网关连接断了、适配层自己抛）。两种都走不到 deletedAt —— 但只有前一条被钉住时，
  //   「抛错被 catch 掉、然后照样写 deletedAt」这种改法仍然能全绿。
  seedDiary({ plan: { day: '', times: [], done: [] }, history: [
    { tid: 'post-3', ok: true, at: 1, content: '要删的那条' },
    { tid: 'post-other', ok: true, at: 2, content: '别的一条' },
  ] })
  const before = readDiary()

  const client = fakeClient()
  const outbox = fakeOutbox({ actResult: () => { throw new Error('socket hang up') } })
  const gateway = createOutboxGateway({ client, outbox })
  const { qzone } = makeQzone({ enabled: true, dryRun: false }, gateway)

  let caught = null
  try { await qzone.remove('post-3') } catch (error) { caught = error }
  assert.equal(caught instanceof OutboxGatewayError, true, '抛错必须变成 OutboxGatewayError 往上走')
  assert.equal(caught.code, 'outbox-threw')
  assert.equal(caught.action, 'delete_qzone_msg')
  assert.match(caught.message, /socket hang up/, '原始错因要带出来（否则日志里只剩一句「失败」）')

  const after = readDiary()
  assert.deepEqual(after, before, '抛错路径上 diary.json 也必须逐字节不变')
  for (const entry of after.history) assert.equal('deletedAt' in entry, false, '抛错路径不许写 deletedAt（' + entry.tid + '）')
  assert.equal(client.calls.length, 0, '抛错也不回落旧 client')
  assert.equal(outbox.acts.length, 1)
  rmSync(diaryFile(), { force: true })
})

test('⑤ 同一条 tid 连删两次 → 两次 outbox.act（不挂摘要幂等：第二次由网关判「已不存在」）', async () => {
  // ★ 为什么必须是「两次请求」而不是「第二次被静默吞掉」：
  //   摘要幂等会让第一次**失败**之后的第二次被当成重复而直接返回，调用方以为删了、
  //   而那条说说其实还在。删除是**撤回**，静默失败比删不掉更难发现。
  const client = fakeClient()
  const outbox = fakeOutbox()
  const gateway = createOutboxGateway({ client, outbox })
  const { qzone } = makeQzone({ enabled: true, dryRun: false }, gateway)

  for (let i = 0; i < 2; i++) await qzone.remove('post-repeat')

  assert.equal(outbox.acts.length, 2, '同一 tid 删两次就是两次请求')
  assert.deepEqual(outbox.acts.map((a) => a.params), [{ tid: 'post-repeat' }, { tid: 'post-repeat' }], '两次的参数逐字相同（不归一、不改写）')
  for (const rec of outbox.acts) {
    assert.equal(rec.action, 'delete_qzone_msg')
    assert.equal('idempotencyKey' in rec.opts, false, '删除不带幂等键（连删两次是意图，不是事故）')
  }
  assert.equal(client.calls.length, 0, '两次都走 outbox.act，一次都不打真 client')
  assert.equal(outbox.sends.length, 0)
})

// ── Qzone post 切片：只用 fake client / fake fetch，不触达真实 QQ 或网络 ──

test('post：范围只收窄到 self；成功回 tid/id，超时固定 60s', async () => {
  const config = { enabled: true, dryRun: false, diary: { visibility: 'friends' } }
  const calls = []
  const { qzone } = makeQzone(config, {
    call: async (action, params, opts) => { calls.push({ action, params, opts }); return { id: 'post-id' } },
  })

  const result = await qzone.post('  hello  ', { visibility: 'self' })
  assert.deepEqual(result, { ok: true, tid: 'post-id', visibility: 'self', label: '仅自己可见', target_uins: [] })
  assert.deepEqual(calls, [{ action: 'send_qzone_msg', params: { content: 'hello', ugc_right: 64 }, opts: { timeoutMs: 60000 } }])

  config.diary.visibility = 'self'
  await qzone.post('still private', { visibility: 'friends' })
  assert.equal(calls[1].params.ugc_right, 64, '单次请求不能把配置的 self 扩大到 friends')
})

test('post：图片下载后重读最新范围，图片 base64 原样透传', async () => {
  const config = { enabled: true, dryRun: false, diary: { visibility: 'friends', audienceQQs: '12345' } }
  const calls = []
  const bytes = Buffer.from([0, 1, 2, 253, 254, 255])
  const oldFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://8.8.8.8/image.png')
    assert.equal(options.redirect, 'follow')
    config.diary.visibility = 'selected'
    config.diary.audienceQQs = '23456,34567'
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
  }
  try {
    const { qzone } = makeQzone(config, { call: async (action, params, opts) => { calls.push({ action, params, opts }); return { tid: 'post-image' } } })
    const result = await qzone.post(' photo ', { images: ['https://8.8.8.8/image.png'] })
    assert.equal(result.tid, 'post-image')
    assert.deepEqual(calls, [{
      action: 'send_qzone_msg',
      params: { content: 'photo', ugc_right: 16, target_uins: [23456, 34567], images: ['base64://' + bytes.toString('base64')] },
      opts: { timeoutMs: 60000 },
    }])
  } finally {
    globalThis.fetch = oldFetch
  }
})

test('post：disabled/dryRun 不发布，下载期间开关变化后也不发布', async () => {
  for (const config of [
    { enabled: false, dryRun: false, diary: { visibility: 'all' } },
    { enabled: true, dryRun: true, diary: { visibility: 'all' } },
  ]) {
    const calls = []
    const { qzone } = makeQzone(config, { call: async (...args) => { calls.push(args); return { tid: 'unexpected' } } })
    const result = await qzone.post('hello')
    assert.equal(result.ok, config.dryRun, 'disabled 返回失败；dryRun 保持原有模拟成功语义')
    assert.deepEqual(calls, [])
  }

  const config = { enabled: true, dryRun: false, diary: { visibility: 'all' } }
  const calls = []
  const oldFetch = globalThis.fetch
  globalThis.fetch = async () => {
    config.enabled = false
    return new Response(Buffer.from([1]), { headers: { 'content-length': '1' } })
  }
  try {
    const { qzone } = makeQzone(config, { call: async (...args) => { calls.push(args); return { tid: 'unexpected' } } })
    const result = await qzone.post('hello', { images: ['https://8.8.8.8/image.png'] })
    assert.equal(result.ok, false)
    assert.match(result.message, /发布前开关已变化/)
    assert.deepEqual(calls, [])
  } finally {
    globalThis.fetch = oldFetch
  }
})

test('post：mode-off 无 client 回落，失败不重试且重复发布不去重', async () => {
  const client = fakeClient()
  const offGateway = createOutboxGateway({ client, outbox: null })
  const { qzone } = makeQzone({ enabled: true, dryRun: false, diary: { visibility: 'all' } }, offGateway)
  const rejected = await qzone.post('off')
  assert.equal(rejected.ok, false)
  assert.equal(client.calls.length, 0)

  const calls = []
  const gateway = { call: async (action, params, opts) => { calls.push({ action, params, opts }); if (calls.length === 1) throw new Error('fake failure'); return { tid: 'second' } } }
  const { qzone: retryQzone } = makeQzone({ enabled: true, dryRun: false, diary: { visibility: 'all' } }, gateway)
  assert.equal((await retryQzone.post('same')).ok, false)
  assert.equal((await retryQzone.post('same')).ok, true)
  assert.equal(calls.length, 2, '每次 post 各调用一次；不自动重试，也不按摘要去重')
  assert.ok(calls.every((call) => call.action === 'send_qzone_msg'))
})

// ── Qzone comment slice: only fake feeds, fake client, and fake outbox ──
function makeSocialConfig({ enabled = true, dryRun = false } = {}) {
  return {
    enabled,
    dryRun,
    botQQ: '100',
    ownerQQ: '999',
    ownerName: '主人',
    qzoneSocial: { enabled: true, replyOwn: false, commentFriends: true, like: false, friendChance: 1, ownerChance: 1, maxPerDay: 10, intervalMin: 60 },
    speakUp: { awakeFrom: 0, awakeTo: 24 },
  }
}

function makeSocialFeed(key) {
  return { appid: 311, uin: '200', key, nickname: 'Friend', time: Math.floor(Date.now() / 1000), html: 'feed body' }
}

function makeSocialHarness(config, feeds, { disableAfterDetail = false } = {}) {
  const clientCalls = []
  const gatewayCalls = []
  const outbox = fakeOutbox()
  const client = {
    calls: clientCalls,
    state: 'connected',
    call: async (action, params, opts) => {
      clientCalls.push({ action, params, opts })
      if (action === 'get_qzone_feeds') return { feeds }
      if (action === 'get_qzone_msg_detail') {
        if (disableAfterDetail) config.enabled = false
        return { content: 'feed body', comments: [] }
      }
      throw new Error('unexpected fake OneBot action: ' + action)
    },
  }
  const gateway = createOutboxGateway({ client, outbox })
  const call = gateway.call.bind(gateway)
  gateway.call = async (...args) => {
    if (args[0] === 'comment_qzone') gatewayCalls.push(args)
    return call(...args)
  }
  const social = createQzoneSocial({
    getConfig: () => config,
    onebot: gateway,
    hub: { selfId: '100', runSystemTurn: async () => 'same comment', logChat() {} },
    log: { info() {}, warn() {}, debug() {} },
    memory: { addEvent() {} },
  })
  return { social, client, outbox, gatewayCalls }
}

test('comment_qzone: fake sendComment caller is gated, routed once per comment, and never retried or deduped', async () => {
  const disabled = makeSocialHarness(makeSocialConfig(), [makeSocialFeed('disabled-post')], { disableAfterDetail: true })
  const disabledResult = await disabled.social.run()
  assert.equal(disabledResult.ok, false, 'sendComment 看到 enabled=false 时维持 disabled 拒绝')
  assert.match(disabledResult.message, /总开关已关闭/)
  assert.equal(disabled.gatewayCalls.length, 0)
  assert.equal(disabled.outbox.acts.length, 0)
  assert.equal(disabled.client.calls.filter((x) => x.action === 'comment_qzone').length, 0)

  const dryRun = makeSocialHarness(makeSocialConfig({ dryRun: true }), [makeSocialFeed('dry-post')])
  assert.equal((await dryRun.social.run()).ok, true, 'dryRun 保持原有模拟成功语义')
  assert.equal(dryRun.gatewayCalls.length, 0)
  assert.equal(dryRun.outbox.acts.length, 0)
  assert.equal(dryRun.client.calls.filter((x) => x.action === 'comment_qzone').length, 0)

  const live = makeSocialHarness(makeSocialConfig(), [makeSocialFeed('post-1'), makeSocialFeed('post-2')])
  const liveResult = await live.social.run()
  assert.equal(liveResult.ok, true, JSON.stringify(liveResult))
  assert.equal(live.gatewayCalls.length, 2, '两条评论各走一次 Gateway')
  assert.equal(live.outbox.acts.length, 2, '同文不同说说不做摘要去重')
  assert.deepEqual(live.outbox.acts.map((x) => x.action), ['comment_qzone', 'comment_qzone'])
  for (let i = 0; i < live.gatewayCalls.length; i++) {
    const [action, params, opts] = live.gatewayCalls[i]
    const rec = live.outbox.acts[i]
    assert.equal(action, 'comment_qzone')
    assert.equal(params, rec.params, 'caller 的 params 同一对象到达 outbox.act')
    assert.deepEqual(params, { tid: `post-${i + 1}`, content: 'same comment', target_uin: 200 })
    assert.equal(opts.timeoutMs, 30000)
    assert.equal(rec.opts.timeoutMs, 30000)
    assert.equal('idempotencyKey' in rec.opts, false)
  }
  assert.equal(live.client.calls.filter((x) => x.action === 'comment_qzone').length, 0, '迁移动作不回落旧 client')
})

// ── 第八片（2026-11-24）：like_qzone 真的从 qzone-social 走到 outbox.act ────────────
//   前一条只证「gateway.call('like_qzone') 改道」。这一条证**调用方**那一侧：
//   参数就是 qzone-social 自己拼的那三个（tid / target_uin / abstime）、超时 20000、
//   一次说说一次点赞、且只在 like 开着 + 总开关开着 + 非试运行时才发生。
//   ★ 全部用假 feeds / 假 client / 假 outbox：没有一个真请求离开本机。
test('like_qzone：只有 like 开着 + 活跑 + 被 pickFeeds 留下的那条才点，参数与超时逐字', async () => {
  const likeConfig = (over = {}) => ({
    enabled: true,
    dryRun: false,
    botQQ: '100',
    ownerQQ: '999',
    ownerName: '主人',
    qzoneSocial: { enabled: true, replyOwn: false, commentFriends: true, like: true, friendChance: 1, ownerChance: 1, maxPerDay: 10, intervalMin: 60 },
    speakUp: { awakeFrom: 0, awakeTo: 24 },
    ...over,
  })
  // ★ pickFeeds 只留 24 小时内的，所以时间必须取「现在」—— 写死一个日历时间会让这条测试
  //   随日期推移自己变红（那正是它第一版翻车的方式：4 个 feed 全被时间窗挡掉，点赞 0 次）。
  const feedTime = Math.floor(Date.now() / 1000)
  const keep = { appid: 311, uin: '200', key: 'like-post-1', nickname: 'Friend', time: feedTime, html: 'feed body' }
  // 三个必须被 pickFeeds 过滤掉的：广告（appid 不是 311）、她自己的说说、超过 24 小时
  const adFeed = { appid: 1, uin: '200', key: 'ad-post', nickname: 'Ad', time: feedTime, html: 'ad' }
  const selfFeed = { appid: 311, uin: '100', key: 'self-post', nickname: 'self', time: feedTime, html: 'self' }
  const oldFeed = { appid: 311, uin: '200', key: 'old-post', nickname: 'Friend', time: feedTime - 90000, html: 'old' }

  const harness = (config, feeds, actResult) => {
    const clientCalls = []
    const outbox = fakeOutbox(actResult ? { actResult } : undefined)
    const client = {
      calls: clientCalls,
      state: 'connected',
      call: async (action, params) => {
        clientCalls.push({ action, params })
        if (action === 'get_qzone_feeds') return { feeds }
        if (action === 'get_qzone_msg_detail') return { content: 'feed body', comments: [] }
        throw new Error('unexpected fake OneBot action: ' + action)
      },
    }
    const gateway = createOutboxGateway({ client, outbox })
    const social = createQzoneSocial({
      getConfig: () => config,
      onebot: gateway,
      hub: { selfId: '100', runSystemTurn: async () => '', logChat() {} },
      log: { info() {}, warn() {}, debug() {} },
      memory: { addEvent() {} },
    })
    return { social, client, outbox }
  }

  // ★ 每条用例用**自己的 feed key**：qzone-social 把看过的 key 记进本地的 seen 列表
  //   （同一个数据目录跨 harness 共享），复用同一个 key 的第二次运行会被「已看过」挡掉 ——
  //   那样 ③ / ④ 会以为自己验的是 like / dryRun，其实验的是 seen。

  // ① 活跑 + like 开着：被留下的那条点一次，参数就是 {tid,target_uin,abstime}
  const live = harness(likeConfig(), [keep, adFeed, selfFeed, oldFeed])
  assert.equal((await live.social.run()).ok, true)
  const likes = live.outbox.acts.filter((x) => x.action === 'like_qzone')
  assert.equal(likes.length, 1, '四个 feed 里只有一个该被点赞（其余三个被 pickFeeds 挡掉）')
  // abstime 就是 feed 自己带的那个时间（Number(f.time)），一个字都没改
  assert.deepEqual(likes[0].params, { tid: 'like-post-1', target_uin: 200, abstime: feedTime }, 'tid / target_uin / abstime 逐字')
  assert.equal(likes[0].opts.timeoutMs, 20000, 'qzone-social 给的 20000 原样往下')
  assert.equal('idempotencyKey' in likes[0].opts, false, '点赞不挂幂等键')
  assert.equal(live.client.calls.filter((x) => x.action === 'like_qzone').length, 0, '改道之后不许再打真 client')
  // ② 点赞不落正文 / 不落 params：交给真实出站口验（假 outbox 没有 view()）。
  //   对应的断言在 test/outbox-mode-gate.test.mjs 的「动作记录没有正文预览」那一条，
  //   以及 tools/outbox-selftest.mjs 的 g) 段 —— 这里再造一份投影判据只会开第二个源头。
  assert.equal(likes[0].action, 'like_qzone')
  assert.equal(Object.keys(likes[0].params).length, 3, '参数只有 tid / target_uin / abstime 三个字段（不多塞）')

  // ③ like 关着：一次都不点（其余照常跑）
  const noLike = harness(likeConfig({ qzoneSocial: { ...likeConfig().qzoneSocial, like: false } }),
    [{ ...keep, key: 'like-off-post' }])
  assert.equal((await noLike.social.run()).ok, true)
  assert.equal(noLike.outbox.acts.filter((x) => x.action === 'like_qzone').length, 0, 'like=false 时一次都不点')

  // ④ 试运行：不点也不评
  const dry = harness(likeConfig({ dryRun: true }), [{ ...keep, key: 'like-dry-post' }])
  assert.equal((await dry.social.run()).ok, true)
  assert.equal(dry.outbox.acts.length, 0, 'dryRun 一个动作都不许出去')

  // ⑤ 出站口回 {ok:false}：点赞失败被 qzone-social 自己吞掉（log.debug），
  //    整轮**不因此失败**；而且失败只发生一次 —— 不重试。
  const failing = harness(likeConfig(), [{ ...keep, key: 'like-fail-post' }], { ok: false, retcode: 100, error: '网关说不行' })
  const failingResult = await failing.social.run()
  assert.equal(failingResult.ok, true, '点赞失败不该把整轮逛空间弄挂（原本就是 try/catch 吞掉的）')
  assert.equal(failing.outbox.acts.filter((x) => x.action === 'like_qzone').length, 1, '失败也不重试：只有一次')
})
