// hub.js 的出站护栏回归测试（只用假的宿主 / 假的 OneBot，不连真网关、不读真配置）。
//   覆盖两处直连 OneBot 的动作：
//     - send_poke          ← deliver() 里的 <poke>（她戳回去）
//     - set_input_status   ← pushToSession() 里的「对方正在输入…」
//   三种模式：
//     enabled=false        → 零调用
//     dryRun=true          → 零调用
//     enabled && !dryRun   → 照旧调用（保证护栏没把正常路径一起关掉）
//   ★ 2026-11-24 第六片追加：发文件（sendFile → upload_group_file / upload_private_file）。
//     它走的不是「直连 OneBot」而是适配层，但保住的是同一件事 ——
//     hub 原有的契约（files.enabled / 总开关 / dryRun / capture / 绝对路径 / 存在 / 普通文件 /
//     允许目录 / maxMB / 120000 超时 / 本机路径失败后 hub 自己回落 base64）一个字都不许变。
//     文件用例建在 AURABOT_DATA_DIR 的临时工作区里，不读部署配置、不发一个字节。
// 数据目录用 AURABOT_DATA_DIR 指向系统临时目录：hub → sessions.json / recent-media.json 都写在那儿，
// 不会碰到 ~/.dsh 下真实的 aurabot 数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-hub-guard-'))

const { createHub } = await import('../src/aurabot/src/chat/hub.js')
// ★ 第六片（2026-11-24）：发文件（hub.sendFile → upload_*_file）也在这份护栏里验。
//   适配层是**纯本地**模块（只有 node:crypto），import 它不会连任何网关 —— 本文件全程 0 网络。
const { createOutboxGateway, selectAurabotOutbox } = await import('../src/aurabot/adapter/outbox-gateway.mjs')

const quietLog = () => new Proxy({}, { get: () => () => {} })

/** 假 OneBot：只记下被调用过的方法名和参数，不连任何网关。 */
function fakeOneBot() {
  const calls = []
  return {
    calls,
    names: () => calls.map((c) => c.action),
    call: async (action, params) => { calls.push({ action, params }); return {} },
  }
}

function fakeStickers() {
  return { enabled: false, match: () => null, pickForReply: () => null, segmentFor: () => null, markUsed() {}, collect: async () => ({ ok: false }) }
}

/** 假 DSH 宿主 + 假会话：agentFor() → mount() → pushToSession() 这条链只要能走通就行。 */
/** 极简 agent：hub 只会用到 session / ctx.tools / ctx.systemPrompt / followup / steer。 */
const pseudoAgent = (sid) => ({
  session: { id: sid, append() {} },
  ctx: { tools: { register: () => () => {}, restrict: () => () => {} }, systemPrompt: { context: () => () => {} } },
  followup: async () => {},
  steer: async () => {},
})

function harness(config, hooks, onebotOverride = null) {
  // onebot 就是 hub 眼里那台「客户端」：真跑的时候是适配层，这里可以换成适配层包着的假客户端。
  const onebot = onebotOverride || fakeOneBot()
  let counter = 0
  const registry = {
    list: async () => [{ id: 'ws-1', path: config.workspaceDir }],
    create: async () => ({ id: 'ws-1' }),
    archivedSessionIds: [],
  }
  const hubRef = {}
  const controller = {
    create: async () => ({ sessionId: 'session-guard-' + (++counter) }),
    rename: async () => {},
    resolveAgent: async (sid) => ({ agent: pseudoAgent(sid) }),
  }
  const dsh = {
    agents: { get: () => null },
    get: (name) => (name === 'workspaceRegistry' ? registry : name === 'sessionController' ? controller : null),
    workspaceRegistry: registry,
  }
  const hub = createHub({
    dsh,
    getConfig: () => config,
    log: quietLog(),
    onebot,
    stickers: fakeStickers(),
    tts: { speak: async () => { throw new Error('测试里不走语音') } },
    buildTools: () => [],
    hooks,
  })
  hubRef.hub = hub
  return { hub, onebot, controller }
}

const baseConfig = (over = {}) => ({
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
})

const waitFor = async (fn, ms = 2000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return fn()
}

/**
 * 走一遍「私聊来了一句 → 交给她（startTyping 在这里发生）→ 这一轮结束，她回一句带 <poke> 的话（deliver → pokeBack）」。
 * 假 agent 记在 agents 表里，resolveAgent 拿得到；followup 只登记调用，回合由测试手动推事件。
 */
async function runPrivateTurn(harnessed) {
  const chatId = 'private:30003'
  const { hub, onebot } = harnessed
  await hub.pushToSession({ chatId, kind: 'private', userId: '30003' }, [{ type: 'text', text: '戳我' }], '30003', {})
  assert.equal(onebot.names().includes('set_input_status'), true, 'live 模式应该在开始这一轮时显示「正在输入…」')
  const chats = hub.sessions()
  const realSid = chats[chatId].sessionId
  const session = { id: realSid }
  hub.onSessionEvent(session, { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '嗯，戳了你一下|||<poke>' }] } } })
  hub.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  // deliver 是异步的：pokeBack 在它里面 await
  assert.equal(await waitFor(() => onebot.names().includes('send_poke')), true, 'live 模式应该戳回去，实际：' + JSON.stringify(onebot.names()))
  return realSid
}

for (const [label, over] of [['enabled=false', { enabled: false }], ['dryRun=true', { dryRun: true }]]) {
  test(label + '：send_poke / set_input_status 一次都不调', async () => {
    const h = harness(baseConfig(over))
    try {
      const chatId = 'private:30003'
      await h.hub.pushToSession({ chatId, kind: 'private', userId: '30003' }, [{ type: 'text', text: '戳我' }], '30003', {})
      const realSid = h.hub.sessions()[chatId].sessionId
      const session = { id: realSid }
      h.hub.onSessionEvent(session, { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '嗯，戳了你一下|||<poke>' }] } } })
      h.hub.onSessionEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
      await new Promise((r) => setTimeout(r, 200))
      const banned = h.onebot.names().filter((n) => n === 'send_poke' || n === 'set_input_status')
      assert.deepEqual(banned, [], label + ' 下这两个动作不该出现，实际全量调用：' + JSON.stringify(h.onebot.calls))
    } finally {
      h.hub.disposeRecentMedia()
    }
  })
}

test('enabled && !dryRun：set_input_status 和 send_poke 照旧发出去', async () => {
  const h = harness(baseConfig())
  try {
    await runPrivateTurn(h)
    const typing = h.onebot.calls.find((c) => c.action === 'set_input_status')
    assert.deepEqual(typing.params, { user_id: 30003, event_type: 1 })
    const poke = h.onebot.calls.find((c) => c.action === 'send_poke')
    assert.deepEqual(poke.params, { user_id: 30003 })
  } finally {
    h.hub.disposeRecentMedia()
  }
})

test('pokeBlocked hook：guarded 模式下告诉她「这一轮本要戳但没戳」，原因是 disabled / dryRun', async () => {
  for (const [label, over, expectReason] of [['enabled=false', { enabled: false }, 'disabled'], ['dryRun=true', { dryRun: true }, 'dryRun']]) {
    const seen = []
    const h = harness(baseConfig(over), { pokeBlocked: (reason, info) => seen.push({ reason, info }) })
    try {
      await h.hub.capture(() => h.hub.deliver('private:30003', '<poke>', {}))
      assert.deepEqual(seen.map((s) => s.reason), [expectReason], label + '：应该报一次 pokeBlocked')
      assert.deepEqual(seen[0].info, { chatId: 'private:30003', target: '30003' })
    } finally {
      h.hub.disposeRecentMedia()
    }
  }
})

// ────────────────────────────────────────────────────────────────────────────
// 第六片（2026-11-24）：发文件 —— hub.sendFile → 适配层 → outbox.act('upload_*_file')
//
//   为什么加在这一份里、而不新开一个文件：这一片**没有**改 hub.js 一个字节，
//   它要保住的正是「hub 原有契约一个字都不许变」。而这份测试本来就是
//   「假宿主 + 假 OneBot 钉 hub 出站护栏」的那一份 —— 上传只是同一个护栏上多出的两个动作名。
//
//   ★ 全程 0 网络：适配层是纯本地模块（只 import node:crypto），假客户端的 call 只往数组里记一笔。
//   ★ 文件都建在 AURABOT_DATA_DIR 下的临时工作区里，和这份测试的其余部分共用同一个 tmp 根，
//     跑完留在系统临时目录，碰不到真实的 aurabot 数据，也碰不到 DSH 的工作区。
//   ★ 这里**不复制**任何一条判据：大小上限 / 允许目录 / base64 回落上限都还是 hub.sendFile 的，
//     这些用例只验「它们仍然发生在 outbox **之前**」，以及「两条路由与 120000 超时逐字」。
// ───────────────────────────────────────────────────────────────────────────

const GUARD_WS = join(process.env.AURABOT_DATA_DIR, 'ws')

/** 一个真文件（放在临时工作区里 —— sendFile 只认「存在 + 是普通文件 + 在允许目录里」）。 */
function guardFile(name, bytes = 32, dir = GUARD_WS) {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, Buffer.alloc(bytes, 'A'))
  return p
}

/** 假客户端：上传不该走到它这里。 */
function guardClient() {
  const calls = []
  return { calls, call: async (action, params, opts) => { calls.push({ action, params, opts }); return { from: 'client' } } }
}

/**
 * 假出站口：记下每一次 act。actResult 可以是固定结果，也可以是 (action, params) => 结果。
 * ★ 它**不**模拟重试、也不模拟回落 —— 那两件事都不在出站口里，在这里模拟等于测自己的假设。
 */
function guardOutbox(actResult = { ok: true, retcode: 0, data: {} }) {
  const acts = []
  return {
    acts,
    // 适配层判「有没有出站口」看的是 send —— 这里给一个只为通过接线判据的桩：
    // 真被调到就是本测试的失败信号（上传不该走 send）。
    send: async () => { throw new Error('上传不该走 outbox.send') },
    act: async (action, params, opts) => {
      acts.push({ action, params, opts })
      return typeof actResult === 'function' ? actResult(action, params) : actResult
    },
  }
}

/** files 默认开着（要验的就是「开着时确实发」），关掉的那几条自己覆盖。 */
const filesConfig = (over = {}) => baseConfig({ workspaceDir: GUARD_WS, files: { enabled: true, dirs: [], maxMB: 50 }, ...over })

test('上传：私聊 / 群各打自己的动作名，params 逐字，timeoutMs=120000', async () => {
  const local = guardFile('guard-report.pdf')
  const client = guardClient()
  const outbox = guardOutbox({ ok: true, retcode: 0, data: { file_id: 'G-1' } })
  const gateway = createOutboxGateway({ client, outbox })
  const h = harness(filesConfig(), {}, gateway)
  try {
    const r1 = await h.hub.sendFile('private:30003', local, 'guard-report.pdf')
    const r2 = await h.hub.sendFile('group:40004', local, 'guard-report.pdf')

    assert.deepEqual(r1, { file_id: 'G-1' }, '成功时把网关的 data 原样交回（hub 的返回值语义没变）')
    assert.deepEqual(r2, { file_id: 'G-1' })
    assert.deepEqual(outbox.acts.map((a) => a.action), ['upload_private_file', 'upload_group_file'],
      '私聊 / 群是两个不同的动作名 —— 打错类型不会报错，只会传到错的地方')
    assert.deepEqual(outbox.acts[0].params, { user_id: 30003, file: local, name: 'guard-report.pdf' })
    assert.deepEqual(outbox.acts[1].params, { group_id: 40004, file: local, name: 'guard-report.pdf' })
    assert.deepEqual(outbox.acts.map((a) => a.opts.timeoutMs), [120000, 120000],
      '★ 每次都带 hub 的 FILE_TIMEOUT_MS=120000 —— 不是 30s 默认，也不被适配层封顶')
    for (const a of outbox.acts) assert.equal('idempotencyKey' in a.opts, false, '上传不挂幂等键')
    assert.equal(client.calls.length, 0, '迁移过的动作不许再打真 client')
    assert.equal(h.hub.stats().sent, 2)
  } finally { h.hub.disposeRecentMedia() }
})

test('上传：本机路径失败 → hub 自己改走 base64，**正好两次**调用，两次的 file 各自逐字', async () => {
  const local = guardFile('guard-small.txt', 64)
  const client = guardClient()
  let attempts = 0
  // 第一次（本机路径）失败、第二次（base64）成功 —— 远程 / 容器网关的真实样子。
  const outbox = guardOutbox((action, params) => {
    attempts += 1
    return params.file.startsWith('base64://')
      ? { ok: true, retcode: 0, data: { file_id: 'G-2' } }
      : { ok: false, retcode: 1200, error: '网关看不到这个路径' }
  })
  const gateway = createOutboxGateway({ client, outbox })
  const h = harness(filesConfig(), {}, gateway)
  try {
    const r = await h.hub.sendFile('group:40004', local, 'guard-small.txt')

    assert.equal(outbox.acts.length, 2, '★ 回落是 hub 的**两次业务调用**，不是传输层重试')
    assert.equal(outbox.acts[0].params.file, local, '第一次是本机路径，逐字（不 resolve、不 trim）')
    assert.match(outbox.acts[1].params.file, /^base64:\/\/[A-Za-z0-9+/=]+$/, '第二次是 base64://<内容>')
    assert.equal(outbox.acts[1].params.name, 'guard-small.txt', '两次的 name 是同一个')
    assert.equal(outbox.acts[0].params.group_id, 40004)
    assert.equal(outbox.acts[1].params.group_id, 40004, '两次都发到同一个群')
    assert.deepEqual(outbox.acts.map((a) => a.opts.timeoutMs), [120000, 120000], '两次都给 120000')
    assert.equal(attempts, 2, '★ 一次 outbox.act 只对应一次传输 —— 传输层不许自己再试（否则两次变四次）')
    assert.equal(client.calls.length, 0)
    assert.deepEqual(r, { file_id: 'G-2' }, '回落成功时返回第二次的 data 原件')
    assert.equal(h.hub.stats().sent, 1, '只有成功的那一次计 sent')
    assert.equal(h.hub.stats().errors, 0, '落了 base64 就不算错')
  } finally { h.hub.disposeRecentMedia() }
})

test('上传：外部网址失败 → **不**回落 base64，只发一次，错误照 hub 原文抛出', async () => {
  const client = guardClient()
  const outbox = guardOutbox({ ok: false, retcode: 1200, error: '下载失败' })
  const gateway = createOutboxGateway({ client, outbox })
  const h = harness(filesConfig(), {}, gateway)
  try {
    await assert.rejects(
      () => h.hub.sendFile('private:30003', 'https://example.invalid/guard.zip', 'guard.zip'),
      (e) => /发文件失败：/.test(e.message) && /下载失败/.test(e.message),
    )
    assert.equal(outbox.acts.length, 1, '外部地址失败只发一次 —— 它本来就不需要 base64 那一手')
    assert.equal(outbox.acts[0].params.file, 'https://example.invalid/guard.zip', '网址逐字')
    assert.equal(outbox.acts[0].opts.timeoutMs, 120000)
    assert.equal(h.hub.stats().errors, 1)
    assert.equal(client.calls.length, 0)
  } finally { h.hub.disposeRecentMedia() }
})

test('上传：mode=off（核心不交出站口）→ 拒绝，且一次都不回落真 client', async () => {
  const client = guardClient()
  const coreOutbox = guardOutbox()
  // 核心那一侧先判：mode=off 时交出去的必须是 null（不是裸出站口）
  assert.equal(selectAurabotOutbox('off', coreOutbox), null, 'mode=off 时核心不许把出站口交出去')

  // ★ 这里用**外部网址**而不是本机文件：本机路径失败时 hub 会自己再走一次 base64，
  //   那条回落会把「一次拒绝」变成「两次拒绝」，于是这条用例量的就不再是 mode 那道闸。
  //   回落的两次调用由上那条用例单独钉（它就该是两次 —— 那是 hub 的业务决定）。
  const gateway = createOutboxGateway({ client, outbox: null, getOutbox: () => null })
  const h = harness(filesConfig(), {}, gateway)
  try {
    await assert.rejects(
      () => h.hub.sendFile('private:30003', 'https://example.invalid/guard-off.zip', 'guard-off.zip'),
      (e) => /发文件失败：/.test(e.message) && /没有出站口/.test(e.message) && /不回落/.test(e.message),
      '没有出站口时必须拒绝，而且要说清「不回落」',
    )
    assert.equal(coreOutbox.acts.length, 0, 'mode=off 时一次上传都不许从出站口出去')
    assert.equal(client.calls.length, 0, '也不许回落到 OneBot client（那等于把闸拆了）')
  } finally { h.hub.disposeRecentMedia() }
})

test('上传：files.enabled=false / 总开关关 / 试运行 → 一个都不进 outbox', async () => {
  const local = guardFile('guard-gate.txt', 8)
  const cases = [
    ['files.enabled=false', { files: { enabled: false, dirs: [] } }, /发文件没打开/],
    ['总开关 enabled=false', { enabled: false }, null],
    ['试运行 dryRun=true', { dryRun: true }, null],
  ]
  for (const [label, over, expect] of cases) {
    const client = guardClient()
    const outbox = guardOutbox()
    const gateway = createOutboxGateway({ client, outbox })
    const h = harness(filesConfig(over), {}, gateway)
    try {
      if (expect) {
        await assert.rejects(() => h.hub.sendFile('private:30003', local, 'guard-gate.txt'), expect,
          label + ' 要在 outbox 之前就拒')
      } else {
        assert.equal(await h.hub.sendFile('private:30003', local, 'guard-gate.txt'), null, label + ' 下不发，返回 null')
      }
      assert.equal(outbox.acts.length, 0, label + ' 时一次上传都不许进 outbox')
      assert.equal(client.calls.length, 0, label + ' 时也不许回落到 OneBot client')
    } finally { h.hub.disposeRecentMedia() }
  }
})

test('上传：允许目录之外 / 超过 maxMB → 在 outbox 之前就拒（零调用）', async () => {
  const client = guardClient()
  const outbox = guardOutbox()
  const gateway = createOutboxGateway({ client, outbox })

  // ① 目录外：建在 tmp 根下（不在这份配置的 workspaceDir 里）
  const outside = guardFile('guard-outside.txt', 8, join(process.env.AURABOT_DATA_DIR, 'outside'))
  const h1 = harness(filesConfig(), {}, gateway)
  try {
    await assert.rejects(() => h1.hub.sendFile('group:40004', outside, 'guard-outside.txt'), /允许发送的目录/,
      '目录校验必须在 outbox 之前')
    assert.equal(outbox.acts.length, 0, '★ 目录外：一个请求都没发')
  } finally { h1.hub.disposeRecentMedia() }

  // ② 超过 maxMB：上限压到 1MB，文件 2MB
  const big = guardFile('guard-over.bin', 2 * 1024 * 1024)
  const h2 = harness(filesConfig({ files: { enabled: true, dirs: [], maxMB: 1 } }), {}, gateway)
  try {
    await assert.rejects(() => h2.hub.sendFile('group:40004', big, 'guard-over.bin'), /文件太大/,
      '大小上限必须在 outbox 之前')
    assert.equal(outbox.acts.length, 0, '★ 超上限：一个请求都没发（不回落 base64，也不发半截）')
  } finally { h2.hub.disposeRecentMedia() }

  assert.equal(client.calls.length, 0)
})

test('上传：capture 短路仍然在 outbox 之前（模拟测试里一个字节都不出站）', async () => {
  const local = guardFile('guard-capture.txt', 8)
  const client = guardClient()
  const outbox = guardOutbox()
  const gateway = createOutboxGateway({ client, outbox })
  const h = harness(filesConfig(), {}, gateway)
  try {
    const { result, sent } = await h.hub.capture(() => h.hub.sendFile('private:30003', local, 'guard-capture.txt'))
    assert.deepEqual(outbox.acts.length, 0, '★ capture 短路在 outbox 之前：模拟测试不许真的发文件')
    assert.equal(client.calls.length, 0)
    assert.equal(sent.length, 1, 'capture 里应当记下这一条')
    assert.match(String(result && result.message_id), /^sim-/, 'capture 返回模拟的 message_id')
  } finally { h.hub.disposeRecentMedia() }
})
