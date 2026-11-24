import test from 'node:test'
import assert from 'node:assert/strict'
import groupAdmin from '../src/aurabot/src/modules/group-admin/index.js'
import { createGroupRoles } from '../src/aurabot/src/chat/group-roles.js'

const ACTIONS = [
  { action: 'ban', user_id: '200' },
  { action: 'unban', user_id: '200' },
  { action: 'kick', user_id: '200' },
  { action: 'title', user_id: '200', text: 'title' },
  { action: 'notice', text: 'notice' },
]

function setupTool ({ groupRoles, turnHasOwner = true, groups = ['100'], dryRun = false }) {
  const writes = []
  let tool
  groupAdmin.setup({
    core: {
      hub: { turnHasOwner: () => turnHasOwner },
      onebot: { call: async (action, params) => { writes.push({ action, params }) } },
      groupRoles,
    },
    context: () => {},
    tool: (create) => {
      tool = create({ chat: { kind: 'group', groupId: '100' }, level: 'full', sessionId: 's' })
    },
    config: () => ({ allow: { groups }, ownerQQ: '999', dryRun }),
    route: () => {},
  })
  return { writes, execute: (args) => tool.execute(args) }
}

test('cached admin/owner followed by fresh role lookup failure denies all five group actions', async () => {
  for (const cachedRole of ['admin', 'owner']) {
    let failLookup = false
    const roles = createGroupRoles({
      getConfig: () => ({ botQQ: '101' }),
      onebot: { call: async (action) => {
        assert.equal(action, 'get_group_member_info')
        if (failLookup) throw new Error('fresh lookup failed')
        return { role: cachedRole }
      } },
    })
    assert.equal(await roles.get('100'), cachedRole, 'seed the role cache')
    failLookup = true

    const tool = setupTool({ groupRoles: roles })
    for (const args of ACTIONS) {
      const result = await tool.execute(args)
      assert.equal(result.ok, false, cachedRole + ' cache must not authorize ' + args.action)
    }
    assert.deepEqual(tool.writes, [], 'authorization lookup failures must cause zero OneBot writes')
  }
})

test('empty and unknown roles deny all five group actions', async () => {
  for (const role of ['', 'moderator']) {
    const groupRoles = {
      get: async (_gid, options) => {
        assert.deepEqual(options, { fresh: true })
        return role
      },
      canManage: (candidate) => candidate === 'owner' || candidate === 'admin',
      peek: () => role,
      label: () => '不清楚',
    }
    const tool = setupTool({ groupRoles })
    for (const args of ACTIONS) {
      const result = await tool.execute(args)
      assert.equal(result.ok, false, JSON.stringify(role) + ' must deny ' + args.action)
    }
    assert.deepEqual(tool.writes, [], 'unknown roles must cause zero OneBot writes')
  }
})

// ────────────────────────────────────────────────────────────────────────────
// ★ 反向的一半（2026-11-24 第七片）：上面两条只证「该拒的拒了」。
//   只断拒绝的话，一个「永远拒绝」的实现也能全绿 —— 所以这一条证**该允许的仍然允许**，
//   并把两个已迁动作的 params **逐字**钉在这里（群号 / 对象 / 头衔 / 公告正文）。
//   名字多一个、少一个，指的就是另一件事；而失败会长成「网关说缺字段」。
// ────────────────────────────────────────────────────────────────────────────
test('valid owner/admin still allowed, title stays owner-only, migrated params are exact', async () => {
  const asRoles = (role) => ({
    get: async () => role,
    canManage: (r) => r === 'owner' || r === 'admin',
    peek: () => role,
    label: () => role,
  })

  const allowed = [
    { role: 'owner', args: { action: 'ban', user_id: '200', minutes: 5 }, lands: 'set_group_ban' },
    { role: 'owner', args: { action: 'unban', user_id: '200' }, lands: 'set_group_ban' },
    { role: 'owner', args: { action: 'kick', user_id: '200' }, lands: 'set_group_kick' },
    { role: 'owner', args: { action: 'title', user_id: '200', text: '头衔' }, lands: 'set_group_special_title' },
    { role: 'owner', args: { action: 'notice', text: '公告' }, lands: '_send_group_notice' },
    { role: 'admin', args: { action: 'ban', user_id: '200', minutes: 5 }, lands: 'set_group_ban' },
    { role: 'admin', args: { action: 'unban', user_id: '200' }, lands: 'set_group_ban' },
    { role: 'admin', args: { action: 'kick', user_id: '200' }, lands: 'set_group_kick' },
    { role: 'admin', args: { action: 'notice', text: '公告' }, lands: '_send_group_notice' },
  ]
  for (const c of allowed) {
    const tool = setupTool({ groupRoles: asRoles(c.role) })
    const result = await tool.execute(c.args)
    assert.equal(result.ok, true, c.role + ' 做 ' + c.args.action + ' 应当允许')
    assert.equal(tool.writes.length, 1, c.role + ' 做 ' + c.args.action + ' 应当正好写一次')
    assert.equal(tool.writes[0].action, c.lands, c.args.action + ' 要落到 ' + c.lands)
  }

  // ★ 第八片（2026-11-24）：禁言 / 解禁 / 踢人也改道走出站口了，所以它们的 params
  //   同样逐字钉在这里 —— 群号是 Number、对象是 Number、时长是**秒**（分钟 × 60）。
  //   ★ 失败会长成「网关说缺字段」，和「本来没发」长得一模一样；所以一个字段都不许漂。
  const banTool = setupTool({ groupRoles: asRoles('owner') })
  await banTool.execute({ action: 'ban', user_id: '200', minutes: 5 })
  assert.deepEqual(banTool.writes[0].params, { group_id: 100, user_id: 200, duration: 300 }, '禁言：分钟 × 60 = 秒')

  const banDefault = setupTool({ groupRoles: asRoles('admin') })
  await banDefault.execute({ action: 'ban', user_id: '200' })
  assert.deepEqual(banDefault.writes[0].params, { group_id: 100, user_id: 200, duration: 600 }, '不给分钟数 → 默认 10 分钟 = 600 秒')

  const unbanTool = setupTool({ groupRoles: asRoles('admin') })
  await unbanTool.execute({ action: 'unban', user_id: '200' })
  assert.deepEqual(unbanTool.writes[0].params, { group_id: 100, user_id: 200, duration: 0 }, '解禁就是 duration:0（同一个动作名）')

  const kickTool = setupTool({ groupRoles: asRoles('admin') })
  await kickTool.execute({ action: 'kick', user_id: '200' })
  assert.deepEqual(kickTool.writes[0].params, { group_id: 100, user_id: 200, reject_add_request: false },
    '踢人：reject_add_request 必须是布尔 false（压成 0 在网关那边可能是别的意思）')

  // ★ 两个已迁动作的 params 逐字（群号是 Number，对象是 Number，正文原样）
  const titleTool = setupTool({ groupRoles: asRoles('owner') })
  await titleTool.execute({ action: 'title', user_id: '200', text: '头衔' })
  assert.deepEqual(titleTool.writes[0].params, { group_id: 100, user_id: 200, special_title: '头衔' })

  const noticeTool = setupTool({ groupRoles: asRoles('owner') })
  await noticeTool.execute({ action: 'notice', text: '公告' })
  assert.deepEqual(noticeTool.writes[0].params, { group_id: 100, content: '公告' })

  // ★ 管理员改专属头衔仍然不行（群主专属），而且一条都不写
  const adminTitle = setupTool({ groupRoles: asRoles('admin') })
  const denied = await adminTitle.execute({ action: 'title', user_id: '200', text: '头衔' })
  assert.equal(denied.ok, false, '管理员改头衔要被拒（群主专属）')
  assert.deepEqual(adminTitle.writes, [], '被拒时一条都不许写')
})

test('dryRun 也过鉴权：有权的人回「试运行」且零写入，查不到身份时试运行照样拒', async () => {
  const asRoles = (role) => ({
    get: async () => role,
    canManage: (r) => r === 'owner' || r === 'admin',
    peek: () => role,
    label: () => role,
  })

  const dry = setupTool({ groupRoles: asRoles('owner'), dryRun: true })
  const r = await dry.execute({ action: 'ban', user_id: '200' })
  assert.equal(r.ok, true, '试运行对有权的人回 ok')
  assert.match(String(r.message), /试运行/)
  assert.deepEqual(dry.writes, [], '试运行一条都不写')

  // ★ 身份查不到时，试运行也要拒 —— 否则「我不知道自己是不是管理员」也会照常回 ok
  const unknown = setupTool({ groupRoles: asRoles(''), dryRun: true })
  const r2 = await unknown.execute({ action: 'ban', user_id: '200' })
  assert.equal(r2.ok, false, '查不到身份时试运行也要拒')
  assert.deepEqual(unknown.writes, [])
})

test('主人开口 / 白名单 / 对象 QQ / 主人保护 四道既有闸都还在（顺序在鉴权之前）', async () => {
  const asRoles = (role) => ({ get: async () => role, canManage: (r) => r === 'owner' || r === 'admin', peek: () => role, label: () => role })

  const noOwner = setupTool({ groupRoles: asRoles('owner'), turnHasOwner: false })
  assert.equal((await noOwner.execute({ action: 'ban', user_id: '200' })).ok, false, '这一轮没有主人说话 → 拒')

  const offGroup = setupTool({ groupRoles: asRoles('owner'), groups: ['999'] })
  assert.equal((await offGroup.execute({ action: 'ban', user_id: '200' })).ok, false, '群不在白名单 → 拒')

  const noUid = setupTool({ groupRoles: asRoles('owner') })
  assert.equal((await noUid.execute({ action: 'kick' })).ok, false, '没说对谁 → 拒')
  assert.equal((await noUid.execute({ action: 'notice', text: '公告' })).ok, true, '公告不需要对象 QQ')

  const ownerProtected = setupTool({ groupRoles: asRoles('owner') })
  assert.equal((await ownerProtected.execute({ action: 'ban', user_id: '999' })).ok, false, '不能对主人禁言')
  assert.equal((await ownerProtected.execute({ action: 'unban', user_id: '999' })).ok, true, '解禁主人是允许的')

  // 每一道闸各自断「被拒的那次一个字都没写」，只留下真正放行的那一条
  assert.deepEqual(noOwner.writes, [], '没有主人开口 → 零写入')
  assert.deepEqual(offGroup.writes, [], '群不在白名单 → 零写入')
  assert.deepEqual(noUid.writes.map((w) => w.action), ['_send_group_notice'], '没对象 QQ 的 kick 被拒；公告不需要对象，照常写')
  assert.deepEqual(ownerProtected.writes.map((w) => w.action), ['set_group_ban'], '禁言主人被拒；解禁那一条照常写')
})

test('ban / unban / kick keep exact caller params behind the role gates', async () => {
  const groupRoles = { get: async () => 'owner', canManage: (role) => role === 'owner' || role === 'admin', peek: () => 'owner', label: () => '群主' }
  const cases = [
    { args: { action: 'ban', user_id: '200', minutes: 5 }, action: 'set_group_ban', params: { group_id: 100, user_id: 200, duration: 300 } },
    { args: { action: 'unban', user_id: '200' }, action: 'set_group_ban', params: { group_id: 100, user_id: 200, duration: 0 } },
    { args: { action: 'kick', user_id: '200' }, action: 'set_group_kick', params: { group_id: 100, user_id: 200, reject_add_request: false } },
  ]
  for (const c of cases) {
    const tool = setupTool({ groupRoles })
    assert.equal((await tool.execute(c.args)).ok, true)
    assert.deepEqual(tool.writes, [{ action: c.action, params: c.params }])
  }
})
