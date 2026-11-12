// members-selftest —— events/members.mjs 的断言（全离线，假 fetch）
import { createMemberResolver, groupIdOf } from '../src/events/members.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; return } fail++; console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra).slice(0, 240) : '')) }

const MEMBERS = [
  { user_id: 3937956599, card: '砚青才是真群主', nickname: '砚青' },
  { user_id: 1901372960, card: '爀曦hylight.', nickname: '爀曦' },
  { user_id: 2956663656, card: '小绪', nickname: '天青色等烟雨' },
  { user_id: 111111, card: '小绪绪', nickname: '另一个' },
  { user_id: 222222, card: '同名', nickname: '同名' },
  { user_id: 333333, card: '同名', nickname: '别的' },
]

function makeFetch (members, opts = {}) {
  const calls = []
  return {
    calls,
    async fetchImpl (url, init) {
      calls.push({ url, body: init && init.body })
      if (opts.throw) throw new Error('网络断了')
      if (opts.http500) return { ok: false, status: 500, async json () { return null } }
      if (opts.noData) return { ok: true, status: 200, async json () { return { retcode: 0 } } }
      return { ok: true, status: 200, async json () { return { retcode: 0, data: members } } }
    },
  }
}

const mk = (opts = {}) => {
  let t = 0
  const f = makeFetch(opts.members || MEMBERS, opts)
  const r = createMemberResolver({
    httpUrl: 'http://127.0.0.1:3002', token: 'x',
    fetchImpl: f.fetchImpl, now: () => t,
    ttlMs: opts.ttlMs, log: () => {},
  })
  return { f, r, advance: (ms) => { t += ms } }
}

// ① 精确匹配群名片
{
  const { r } = mk()
  ok('群名片精确', (await r.resolve('661580035', '砚青才是真群主')) === '3937956599', null)
}
// ② 精确匹配昵称
{
  const { r } = mk()
  ok('昵称精确', (await r.resolve('661580035', '爀曦')) === '1901372960', null)
}
// ③ 带 @ 前缀也要能匹配
{
  const { r } = mk()
  ok('去掉 @ 前缀', (await r.resolve('661580035', '@小绪')) === '2956663656', null)
}
// ④ 唯一前缀
{
  const { r } = mk()
  ok('唯一前缀', (await r.resolve('661580035', '天青色')) === '2956663656', null)
}
// ⑤ 同名多人 → 不猜，返回 null
{
  const { r } = mk()
  ok('同名多人不猜', (await r.resolve('661580035', '同名')) === null, null)
}
// ⑥ 查不到 → null（不返回最像的那个）
{
  const { r } = mk()
  ok('查不到给 null', (await r.resolve('661580035', '根本没有这个人')) === null, null)
}
// ⑦ 缓存：第二次不再 fetch
{
  const { f, r, advance } = mk()
  await r.resolve('661580035', '砚青')
  await r.resolve('661580035', '爀曦')
  ok('两次解析只拉一次成员表', f.calls.length === 1, f.calls.length)
  advance(11 * 60 * 1000)
  await r.resolve('661580035', '砚青')
  ok('过期后重新拉', f.calls.length === 2, f.calls.length)
}
// ⑧ 拉了成员表要能报出来
{
  const { r } = mk()
  await r.resolve('661580035', '砚青')
  const v = r.view()
  ok('view 有 hasHttpUrl', v.hasHttpUrl === true, v)
  ok('view 记录 fetches', v.fetches === 1, v.fetches)
  ok('view 记录缓存群数', v.cachedGroups === 1, v.cachedGroups)
  ok('view 成员数对', v.members[0] && v.members[0].count === MEMBERS.length, v.members)
}
// ⑨ 网络错 → 抛出（不是静默返回 null）
{
  const { r } = mk({ throw: true })
  let threw = false
  try { await r.resolve('661580035', '砚青') } catch { threw = true }
  ok('网络错要抛出来', threw === true, null)
}
// ⑩ HTTP 500 → 抛出
{
  const { r } = mk({ http500: true })
  let threw = false
  try { await r.resolve('661580035', '砚青') } catch { threw = true }
  ok('HTTP 500 要抛出来', threw === true, null)
}
// ⑪ 返回里没有 data 数组 → 抛出（不能当成「群里没人」）
{
  const { r } = mk({ noData: true })
  let threw = false
  try { await r.resolve('661580035', '砚青') } catch { threw = true }
  ok('没有 data 要抛出来', threw === true, null)
}
// ⑫ groupIdOf
{
  ok('从 group: 取群号', groupIdOf('group:661580035') === '661580035', groupIdOf('group:661580035'))
  ok('私聊返回空', groupIdOf('private:1901372960') === '', groupIdOf('private:1901372960'))
  ok('乱七八糟返回空', groupIdOf('xxx') === '', null)
}
// ⑬ 请求体要带 group_id（数字，不是字符串）
{
  const { f, r } = mk()
  await r.resolve('661580035', '砚青')
  const body = JSON.parse(f.calls[0].body)
  ok('请求体 group_id 是数字', typeof body.group_id === 'number' && body.group_id === 661580035, body)
  ok('打的是 get_group_member_list', f.calls[0].url.endsWith('/get_group_member_list'), f.calls[0].url)
}

console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + ' · ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
