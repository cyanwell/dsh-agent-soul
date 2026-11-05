// 按群头衔不理：只在勾选的群生效；优先用事件里的头衔，没有再查（有缓存）；查不到这条先不回；拉取头衔按人数排。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTitleFilter, normTitle } from '../src/chat/title-filter.js'
import { normalize } from '../src/core/config.js'

function setup({ rule = { enabled: true, groups: ['10001'], title: '大肥鱼' }, member = {}, fail = false, lists = {} } = {}) {
  const calls = []
  let t = 1_000_000
  const onebot = {
    call: async (action, params) => {
      calls.push([action, params])
      if (fail) throw new Error('网关断了')
      if (action === 'get_group_member_info') return { user_id: params.user_id, title: member[String(params.user_id)] }
      if (action === 'get_group_member_list') { if (!lists[String(params.group_id)]) throw new Error('不在群里'); return lists[String(params.group_id)] }
      return null
    },
  }
  const cfg = { titleFilter: rule }
  const f = createTitleFilter({ getConfig: () => cfg, onebot, log: { debug() {}, warn() {} }, now: () => t })
  return { f, calls, cfg, tick: (ms) => { t += ms } }
}
const ev = (gid, uid, title) => ({ message_type: 'group', group_id: Number(gid), user_id: Number(uid), sender: { user_id: Number(uid), ...(title === undefined ? {} : { title }) } })

test('事件里带了头衔：一字不差才不理；没勾的群、关掉开关都照常', async () => {
  const { f, calls, cfg } = setup()
  assert.equal(await f.shouldIgnore(ev('10001', '2001', '大肥鱼')), true)
  assert.equal(await f.shouldIgnore(ev('10001', '2001', ' 大肥鱼​ ')), true, '首尾空白和零宽字符不算')
  assert.equal(await f.shouldIgnore(ev('10001', '2002', '大肥鱼粉丝')), false)
  assert.equal(await f.shouldIgnore(ev('10002', '2001', '大肥鱼')), false, '没勾的群')
  cfg.titleFilter = { ...cfg.titleFilter, enabled: false }
  assert.equal(await f.shouldIgnore(ev('10001', '2001', '大肥鱼')), false, '开关关了')
  assert.equal(calls.length, 0, '事件里有头衔就不用查')
})

test('事件里没头衔：查一次群成员信息并缓存 60 秒；接口不给头衔字段就当没头衔', async () => {
  const { f, calls, tick } = setup({ member: { 2001: '大肥鱼', 2003: undefined } })
  assert.equal(await f.shouldIgnore(ev('10001', '2001')), true)
  assert.equal(await f.shouldIgnore(ev('10001', '2001')), true)
  assert.equal(calls.length, 1, '第二条走缓存')
  tick(61_000)
  await f.shouldIgnore(ev('10001', '2001'))
  assert.equal(calls.length, 2, '过了 60 秒重新查')
  assert.equal(await f.shouldIgnore(ev('10001', '2003')), false, '没有头衔字段 = 没头衔，不误伤')
})

test('查不到头衔（网关出错）：这条先不回，5 秒内不重复查', async () => {
  const { f, calls, tick } = setup({ fail: true })
  assert.equal(await f.shouldIgnore(ev('10001', '2001')), true)
  assert.equal(await f.shouldIgnore(ev('10001', '2001')), true)
  assert.equal(calls.length, 1)
  tick(6000)
  await f.shouldIgnore(ev('10001', '2001'))
  assert.equal(calls.length, 2)
})

test('拉取头衔：合并各群、按人数从多到少，拉不到的群单独列出来', async () => {
  const { f } = setup({ lists: {
    10001: [{ user_id: 1, title: '大肥鱼', card: '鱼一号' }, { user_id: 2, title: '群主', nickname: '老大' }, { user_id: 3, title: '' }],
    10002: [{ user_id: 4, title: '大肥鱼', nickname: '鱼二号' }],
  } })
  const r = await f.titlesIn(['10001', '10002', '10003'])
  assert.deepEqual(r.titles.map((x) => [x.title, x.count]), [['大肥鱼', 2], ['群主', 1]])
  assert.deepEqual(r.titles[0].members.map((m) => m.name), ['鱼一号', '鱼二号'])
  assert.deepEqual(r.failed, ['10003'])
})

test('配置：默认开着但没勾群（等于不起作用）；群号去重去非法（和群白名单同一套规则）；头衔空了回到默认', () => {
  assert.deepEqual(normalize({}).titleFilter, { enabled: true, groups: [], title: '大肥鱼' })
  const c = normalize({ titleFilter: { groups: ['123456', 123456, 'abc'], title: '  ' } }).titleFilter
  assert.deepEqual(c.groups, ['123456'])
  assert.equal(c.title, '大肥鱼')
  assert.equal(normTitle('﻿机器人 '), '机器人')
})
