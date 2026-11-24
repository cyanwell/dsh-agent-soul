import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { OUTBOX_PORT } from '../src/adapters/outbox.mjs'
import { createModules } from '../src/aurabot/src/core/modules.js'
import { createAvatarSyncHandler, createModuleCoreFacade, MODULE_ONEBOT_READ_ACTIONS, MODULE_ONEBOT_WRITE_ACTIONS, oneBotWriteBlockCode } from '../src/aurabot/src/core/module-onebot-policy.mjs'

function harness(initialConfig) {
  let config = initialConfig
  const calls = []
  const originalOneBot = { state: 'ready', call: (...args) => { calls.push(args); return { ok: true } } }
  const core = { onebot: originalOneBot, hub: { marker: 'same hub' } }
  const access = createModuleCoreFacade(core, () => config)
  return { access, calls, originalOneBot, setConfig: (next) => { config = next } }
}

// ★ 这两份字面量是**期望**，不是第二份实现：实现那份唯一来源是出站口的 OUTBOX_PORT.actions。
//   写名单的顺序 = 出站口那个顺序（3 send/poke + 19 act，新增名字一律追加在末尾）。
const CANONICAL_WRITES = [
  'send_group_msg', 'send_private_msg', 'send_poke',
  'set_input_status', 'modify_custom_face', 'delete_custom_face', 'set_self_longnick',
  'set_qq_profile', 'set_qq_avatar', 'add_custom_face',
  'set_friend_add_request', 'set_doubt_friends_add_request', 'delete_qzone_msg',
  'upload_group_file', 'upload_private_file', 'set_group_special_title', '_send_group_notice',
  'send_qzone_msg', 'comment_qzone', 'set_group_ban', 'set_group_kick', 'like_qzone',
]

// ★ 读名单：每一条都在本仓有字面调用点（审计见文件末尾两条测试）。
const CANONICAL_READS = [
  'get_login_info', 'get_stranger_info', 'get_group_info', 'get_group_member_info',
  'get_group_member_list', 'get_friend_list', 'get_msg', 'get_record', 'get_forward_msg',
  'get_image', 'get_group_msg_history', 'get_friend_msg_history',
  'get_doubt_friends_add_request', 'get_qzone_msg_list', 'get_qzone_msg_detail',
  'get_qzone_feeds', 'fetch_custom_face', 'fetch_ptt_text', 'fetch_sys_faces',
]

test('the write inventory is derived from the outbox port, frozen, and keeps its order', () => {
  assert.equal(MODULE_ONEBOT_WRITE_ACTIONS.length, 22)
  assert.equal(Object.isFrozen(MODULE_ONEBOT_WRITE_ACTIONS), true)
  assert.deepEqual([...MODULE_ONEBOT_WRITE_ACTIONS], CANONICAL_WRITES)
  // 单一来源：等于出站口那份名单本身，而不是本文件里另抄一遍
  assert.deepEqual([...OUTBOX_PORT.actions], CANONICAL_WRITES)
  assert.deepEqual([...MODULE_ONEBOT_WRITE_ACTIONS], [...OUTBOX_PORT.actions])
})

test('the read inventory is the verified literal read list, frozen, and disjoint from writes', () => {
  assert.equal(MODULE_ONEBOT_READ_ACTIONS.length, 19)
  assert.equal(Object.isFrozen(MODULE_ONEBOT_READ_ACTIONS), true)
  assert.deepEqual([...MODULE_ONEBOT_READ_ACTIONS], CANONICAL_READS)
  for (const action of MODULE_ONEBOT_READ_ACTIONS) {
    assert.equal(MODULE_ONEBOT_WRITE_ACTIONS.includes(action), false, action + ' 不能同时在读写两张表里')
  }
  for (const action of MODULE_ONEBOT_WRITE_ACTIONS) {
    assert.equal(MODULE_ONEBOT_READ_ACTIONS.includes(action), false, action + ' 不能同时在读写两张表里')
  }
})

test('shared direct-write gate distinguishes disabled, dryRun, and live modes', () => {
  assert.equal(oneBotWriteBlockCode(null), 'disabled')
  assert.equal(oneBotWriteBlockCode({ enabled: false, dryRun: false }), 'disabled')
  assert.equal(oneBotWriteBlockCode({ enabled: true, dryRun: true }), 'dry-run')
  assert.equal(oneBotWriteBlockCode({ enabled: true, dryRun: false }), null)
})

test('host avatar sync handler stops before file reads and client call when disabled/dryRun', async () => {
  for (const config of [{ enabled: false, dryRun: false }, { enabled: true, dryRun: true }]) {
    let reads = 0
    const calls = []
    const handler = createAvatarSyncHandler({
      getConfig: () => config,
      readAvatar: async () => { reads++; return Buffer.from('avatar') },
      onebot: { call: async (...args) => { calls.push(args); return { ok: true } } },
    })
    const result = await handler()
    assert.equal(result.ok, false)
    assert.equal(result.code, config.enabled ? 'dry-run' : 'disabled')
    assert.equal(reads, 0)
    assert.deepEqual(calls, [])
  }
})

test('host avatar sync handler preserves live OneBot action and result', async () => {
  const calls = []
  const handler = createAvatarSyncHandler({
    getConfig: () => ({ enabled: true, dryRun: false }),
    readAvatar: async () => Buffer.from('avatar'),
    onebot: { call: async (...args) => { calls.push(args); return { ok: true } } },
  })
  const result = await handler()
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [['set_qq_avatar', { file: 'base64://YXZhdGFy' }]])
})

test('all audited write actions reject asynchronously at all module entry points while disabled or dryRun', async () => {
  for (const config of [{ enabled: false, dryRun: false }, { enabled: true, dryRun: true }]) {
    const { access, calls } = harness(config)
    const entries = [
      (action) => access.call(action, { target: 1 }),
      (action) => access.onebot.call(action, { target: 1 }),
      (action) => access.core.onebot.call(action, { target: 1 }),
      (action) => Object.getOwnPropertyDescriptor(access.core, 'onebot').value.call(action, { target: 1 }),
      (action) => Object.getOwnPropertyDescriptor(access.core.onebot, 'call').value(action, { target: 1 }),
    ]
    for (const action of MODULE_ONEBOT_WRITE_ACTIONS) {
      for (const invoke of entries) {
        const pending = invoke(action)
        assert.equal(typeof pending?.then, 'function')
        await assert.rejects(pending, (error) => error.code === 'onebot-write-blocked' && error.stage === 'policy')
      }
    }
    assert.deepEqual(calls, [])
  }
})

test('read calls work and reflective OneBot descriptors stay on the frozen facade', async () => {
  const { access, calls, originalOneBot } = harness({ enabled: true, dryRun: true })
  assert.equal(access.core.hub.marker, 'same hub')
  assert.equal(access.onebot.state, 'ready')
  await access.call('get_group_member_list', { group_id: 12 }, { timeoutMs: 500 })
  await access.core.onebot.call('get_friend_list', {}, { retries: 0 })
  assert.deepEqual(calls, [
    ['get_group_member_list', { group_id: 12 }, { timeoutMs: 500 }],
    ['get_friend_list', {}, { retries: 0 }],
  ])
  const clientDescriptor = Object.getOwnPropertyDescriptor(access.core, 'onebot')
  const callDescriptor = Object.getOwnPropertyDescriptor(access.core.onebot, 'call')
  assert.equal(clientDescriptor.value, access.onebot)
  assert.notEqual(clientDescriptor.value, originalOneBot)
  assert.equal(callDescriptor.value, access.call)
  assert.throws(() => { access.core.onebot.call = originalOneBot.call })
  assert.throws(() => Object.defineProperty(access.core, 'onebot', { value: originalOneBot }))
  assert.equal(Object.isFrozen(access.onebot), true)
})

test('live writes preserve the original action, params, and opts through both paths', async () => {
  const { access, calls } = harness({ enabled: true, dryRun: false })
  const params = { group_id: 12, user_id: 34, duration: 60 }
  const opts = { timeoutMs: 1200 }
  await access.call('set_group_ban', params, opts)
  await access.core.onebot.call('delete_qzone_msg', { tid: 'post-1' })
  assert.deepEqual(calls, [
    ['set_group_ban', params, opts],
    ['delete_qzone_msg', { tid: 'post-1' }, undefined],
  ])
})

test('padded write actions are gated by the trimmed name yet reach the client verbatim when live', async () => {
  const padded = ' upload_private_file '
  const params = { group_id: 12, file: '/offline/avatar.png', name: 'avatar.png' }
  const opts = { timeoutMs: 900 }

  for (const config of [{ enabled: false, dryRun: false }, { enabled: true, dryRun: true }]) {
    const { access, calls } = harness(config)
    const entries = [
      (action) => access.call(action, params, opts),
      (action) => access.onebot.call(action, params, opts),
      (action) => access.core.onebot.call(action, params, opts),
    ]
    for (const invoke of entries) {
      const pending = invoke(padded)
      assert.equal(typeof pending?.then, 'function')
      await assert.rejects(pending, (error) => error.code === 'onebot-write-blocked' && error.stage === 'policy' && error.reason === (config.enabled ? 'dry-run' : 'disabled'))
    }
    assert.deepEqual(calls, [])
  }

  const live = harness({ enabled: true, dryRun: false })
  await live.access.call(padded, params, opts)
  await live.access.core.onebot.call(padded, params, opts)
  assert.deepEqual(live.calls, [[padded, params, opts], [padded, params, opts]])
  for (const args of live.calls) {
    assert.equal(args[0], padded)
    assert.equal(String(args[0]).trim(), 'upload_private_file')
    assert.equal(args[1], params)
    assert.equal(args[2], opts)
  }
})

test('policy reads current config at call time and rejects as a Promise', async () => {
  const { access, calls, setConfig } = harness({ enabled: true, dryRun: false })
  setConfig({ enabled: false, dryRun: false })
  await assert.rejects(access.call('set_group_kick', { group_id: 12, user_id: 34 }), (error) => error.code === 'onebot-write-blocked')
  assert.deepEqual(calls, [])
})

test('throwing config getters reject write calls with a stable code while reads still pass', async () => {
  const calls = []
  const access = createModuleCoreFacade({ onebot: { call: async (...args) => { calls.push(args); return { ok: true } } } }, () => { throw new Error('config exploded') })
  const pending = access.call('set_group_ban', { group_id: 12 })
  assert.equal(typeof pending?.then, 'function')
  await assert.rejects(pending, (error) => error.code === 'onebot-policy-config-failed' && error.stage === 'policy')
  await access.call('get_login_info', {})
  assert.deepEqual(calls, [['get_login_info', {}, undefined]])
})

test('disabled policy takes precedence over a missing OneBot client', async () => {
  const access = createModuleCoreFacade({}, () => ({ enabled: false, dryRun: false }))
  await assert.rejects(access.call('send_group_msg', {}), (error) => error.code === 'onebot-write-blocked' && error.stage === 'policy' && error.reason === 'disabled')
  // 未分类动作同样先撞 policy 闸，而不是先报 client 缺失
  await assert.rejects(access.call('custom_facade_probe', {}), (error) => error.code === 'onebot-write-blocked' && error.stage === 'policy' && error.reason === 'unclassified')
  await assert.rejects(access.call('get_login_info', {}), (error) => error.code === 'onebot-unavailable')
})

test('missing OneBot client does not block module creation; only QQ calls fail', async () => {
  const hub = { marker: 'still available' }
  const access = createModuleCoreFacade({ hub }, () => ({ enabled: true, dryRun: false }))
  assert.equal(access.core.hub.marker, 'still available')
  assert.equal(access.onebot.state, 'disconnected')
  await assert.rejects(access.call('get_login_info', {}), (error) => error.code === 'onebot-unavailable' && error.stage === 'adapter')
  await assert.rejects(access.core.onebot.call('set_qq_avatar', {}), (error) => error.code === 'onebot-unavailable')
})

test('createModules starts a builtin without OneBot and fails only when the module calls QQ', async () => {
  let api
  const config = { enabled: true, dryRun: false, safeMode: true, modules: {} }
  const logger = { child() { return this }, info() {}, warn() {}, error() {} }
  const modules = createModules({
    ctx: {},
    core: { hub: {} },
    getConfig: () => config,
    setConfig() {},
    logger,
    version: 'test',
    builtins: [{ id: 'offline-probe', name: 'Offline Probe', setup: (value) => { api = value; return {} } }],
  })
  try {
    await modules.sync()
    assert.ok(api)
    assert.equal(api.core.onebot.state, 'disconnected')
    await assert.rejects(api.onebot('get_login_info', {}), (error) => error.code === 'onebot-unavailable')
  } finally {
    modules.dispose()
  }
})

test('createModules wires api.onebot and api.core.onebot through the shared policy facade', async () => {
  let api
  let config = { enabled: true, dryRun: true, safeMode: true, modules: {} }
  const calls = []
  const onebot = { state: 'connected', call: async (...args) => { calls.push(args); return { ok: true } } }
  const logger = { child() { return this }, info() {}, warn() {}, error() {} }
  const modules = createModules({
    ctx: {},
    core: { onebot, hub: {} },
    getConfig: () => config,
    setConfig: (next) => { config = typeof next === 'function' ? next(config) : next },
    logger,
    version: 'test',
    builtins: [{ id: 'policy-probe', name: 'Policy Probe', setup: (value) => { api = value; return {} } }],
  })
  try {
    await modules.sync()
    assert.ok(api)
    assert.equal(api.core.onebot.state, 'connected')
    await assert.rejects(api.onebot('set_group_ban', { group_id: 12, user_id: 34 }), (error) => error.code === 'onebot-write-blocked')
    await assert.rejects(api.core.onebot.call('delete_qzone_msg', { tid: 'post-1' }), (error) => error.code === 'onebot-write-blocked')
    assert.deepEqual(calls, [])

    config = { ...config, dryRun: false }
    const params = { group_id: 12, user_id: 34, duration: 60 }
    const opts = { timeoutMs: 1200 }
    await api.onebot('set_group_ban', params, opts)
    await api.core.onebot.call('delete_qzone_msg', { tid: 'post-1' })
    assert.deepEqual(calls, [
      ['set_group_ban', params, opts],
      ['delete_qzone_msg', { tid: 'post-1' }, undefined],
    ])
  } finally {
    modules.dispose()
  }
})

// ────────────────────────────────────────────────────────────────────────────
// 写 / 读 / 未分类三类名字的判法（2026-11-24 收紧）
// ────────────────────────────────────────────────────────────────────────────

test('every registered read passes in disabled and dryRun through every entry alias', async () => {
  for (const config of [{ enabled: false, dryRun: false }, { enabled: true, dryRun: true }]) {
    const { access, calls } = harness(config)
    const entries = [
      (action) => access.call(action, { probe: 1 }),
      (action) => access.onebot.call(action, { probe: 1 }),
      (action) => access.core.onebot.call(action, { probe: 1 }),
    ]
    for (const action of MODULE_ONEBOT_READ_ACTIONS) {
      for (const invoke of entries) await invoke(action)
    }
    assert.equal(calls.length, MODULE_ONEBOT_READ_ACTIONS.length * entries.length)
    for (const args of calls) {
      assert.equal(MODULE_ONEBOT_READ_ACTIONS.includes(String(args[0]).trim()), true)
      assert.deepEqual(args[1], { probe: 1 })
    }
  }
})

test('padded read names are looked up trimmed and passed verbatim in dryRun', async () => {
  const { access, calls } = harness({ enabled: true, dryRun: true })
  await access.call(' get_msg ', { message_id: 1 })
  await access.core.onebot.call(' get_qzone_msg_list ', { num: 5 })
  assert.deepEqual(calls, [
    [' get_msg ', { message_id: 1 }, undefined],
    [' get_qzone_msg_list ', { num: 5 }, undefined],
  ])
})

test('unclassified actions reject as onebot-write-blocked/unclassified while disabled or dryRun', async () => {
  for (const config of [{ enabled: false, dryRun: false }, { enabled: true, dryRun: true }]) {
    const { access, calls } = harness(config)
    const entries = [
      (action) => access.call(action, { probe: 1 }),
      (action) => access.onebot.call(action, { probe: 1 }),
      (action) => access.core.onebot.call(action, { probe: 1 }),
    ]
    // ★ 不做前缀猜：长得很像读的名字（get_ 开头、大小写近似、多一个后缀）同样是未分类
    for (const action of ['custom_facade_probe', 'get_facade_probe', 'Get_Login_Info', 'get_login_info_extra']) {
      for (const invoke of entries) {
        const pending = invoke(action)
        assert.equal(typeof pending?.then, 'function')
        await assert.rejects(pending, (error) => {
          assert.equal(error.code, 'onebot-write-blocked')
          assert.equal(error.reason, 'unclassified')
          assert.equal(error.stage, 'policy')
          assert.match(error.message, /MODULE_ONEBOT_READ_ACTIONS/)
          return true
        })
      }
    }
    assert.deepEqual(calls, [])
  }
})

test('unclassified actions preserve raw passthrough in live mode', async () => {
  const { access, calls } = harness({ enabled: true, dryRun: false })
  const params = { probe: true }
  const opts = { timeoutMs: 700 }
  await access.call(' custom_facade_probe ', params, opts)
  await access.core.onebot.call('custom_facade_probe', params, opts)
  assert.deepEqual(calls, [
    [' custom_facade_probe ', params, opts],
    ['custom_facade_probe', params, opts],
  ])
})

test('live unclassified still reports onebot-unavailable when the client is missing', async () => {
  const access = createModuleCoreFacade({}, () => ({ enabled: true, dryRun: false }))
  await assert.rejects(access.call('custom_facade_probe', {}), (error) => error.code === 'onebot-unavailable' && error.stage === 'adapter')
})

test('a throwing config getter rejects unclassified actions fail-closed while reads still pass', async () => {
  const calls = []
  const access = createModuleCoreFacade({ onebot: { call: async (...args) => { calls.push(args); return { ok: true } } } }, () => { throw new Error('config exploded') })
  await assert.rejects(access.call('custom_facade_probe', {}), (error) => error.code === 'onebot-policy-config-failed' && error.stage === 'policy')
  await access.call('get_login_info', {})
  assert.deepEqual(calls, [['get_login_info', {}, undefined]])
})

test('empty or whitespace action names reject in every mode without touching the client', async () => {
  for (const config of [{ enabled: false, dryRun: false }, { enabled: true, dryRun: true }, { enabled: true, dryRun: false }]) {
    const { access, calls } = harness(config)
    for (const bad of ['', '   ', '\t\n ']) {
      const pending = access.call(bad, {})
      assert.equal(typeof pending?.then, 'function')
      await assert.rejects(pending, (error) => error.code === 'onebot-action-invalid' && error.stage === 'policy')
    }
    assert.deepEqual(calls, [])
  }
})

// ────────────────────────────────────────────────────────────────────────────
// 离线静态盘点：模块 facade 能走到的调用点（不看仓库别处，不做全仓扫）
// ★ 名单是**手挑的**：模块自己 + 模块把 facade 传进去的那几个 feature / helper。
//   新增一个模块文件要加进这张表 —— 那是判断，不是自动发现。
// ────────────────────────────────────────────────────────────────────────────
const FACADE_REACHABLE = [
  'src/aurabot/src/modules/contacts/index.js',
  'src/aurabot/src/modules/diary/index.js',
  'src/aurabot/src/modules/group-admin/index.js',
  'src/aurabot/src/modules/qq-tools/index.js',
  'src/aurabot/src/modules/profile/index.js',
  'src/aurabot/src/modules/stickers/index.js',
  'src/aurabot/src/modules/voice/index.js',
  'src/aurabot/src/modules/qzone-social/index.js',
  'src/aurabot/src/features/qzone.js',
  'src/aurabot/src/features/qq-profile.js',
  'src/aurabot/src/features/qzone-social.js',
  'src/aurabot/src/features/stickers.js',
  'src/aurabot/src/core/net.js',
]

function literalCallsIn(text) {
  const hits = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    // 动态名字（变量 / 模板串 / 拼接）在这道闸下不可审计：出现就失败
    if (/onebot\??\.call\??\.?\(\s*[^'"\s)]/.test(line)) hits.push({ line: i + 1, dynamic: line.trim() })
    const re = /onebot\??\.call\??\.?\(\s*(['"])([^'"]+)\1/g
    let m
    while ((m = re.exec(line))) hits.push({ line: i + 1, action: m[2] })
  })
  return hits
}

test('facade-reachable literal callsites are all classified (35 = 21 writes + 14 reads)', () => {
  const rows = []
  for (const rel of FACADE_REACHABLE) {
    const text = readFileSync(new URL('../' + rel, import.meta.url), 'utf8')
    for (const hit of literalCallsIn(text)) {
      assert.equal(hit.dynamic, undefined, rel + ':' + hit.line + ' 出现动态动作名：' + hit.dynamic)
      rows.push({ rel, ...hit })
    }
  }
  assert.equal(rows.length, 35, 'facade 调用点盘点数变了：先重新盘点，再同步这里的 21/14')
  const writes = rows.filter((r) => MODULE_ONEBOT_WRITE_ACTIONS.includes(r.action))
  const reads = rows.filter((r) => MODULE_ONEBOT_READ_ACTIONS.includes(r.action))
  assert.equal(writes.length, 21)
  assert.equal(reads.length, 14)
  for (const row of rows) {
    assert.ok(MODULE_ONEBOT_WRITE_ACTIONS.includes(row.action) || MODULE_ONEBOT_READ_ACTIONS.includes(row.action), row.rel + ':' + row.line + ' 的 ' + row.action + ' 既不是已知写、也没登记成读')
  }
})

test('every registered read name has a literal callsite somewhere in the aurabot sources', () => {
  const root = fileURLToPath(new URL('../src/aurabot/src/', import.meta.url))
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(js|mjs)$/.test(entry.name)) files.push(full)
    }
  }
  walk(root)
  const found = new Set()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const hit of literalCallsIn(text)) if (hit.action) found.add(hit.action)
  }
  for (const action of MODULE_ONEBOT_READ_ACTIONS) {
    assert.equal(found.has(action), true, action + ' 在 aurabot 源码里找不到字面调用点 —— 不许登记不存在的读')
  }
})
