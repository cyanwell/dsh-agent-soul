// 单测：bridge 回复读取的**截断闸** + 只读宿主不被误判
//
// ★ 为什么要有它（2026-11-16 · 架构收敛第 1 批补闸）：
//   readAllSessionViaBridge 有两条腿 —— 分页全读（认 maxFrames、超了抛错），
//   和 tailFrames 捷径（一次读最后 N 帧，**不看 maxFrames、不翻页**）。
//   回复读取只该走第一条。给成第二条时，截断看起来就像「她这一轮没说」——
//   那正是第 1 批要消灭的那种静默失败。
//
// ★ 本测试不连任何真实宿主、不读任何真实会话：control 是假的。
import { createReplyReaderViaBridge } from '../src/events/reply.mjs'

const out = []
let failed = 0
const check = (label, ok, extra) => {
  out.push((ok ? '  ✓ ' : '  ✗ ') + label + (extra === undefined ? '' : '   [' + extra + ']'))
  if (!ok) failed += 1
}

const frames = () => ([
  { seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
  { seq: 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '回复正文' }] } } },
  { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
])

/** 假 control：记下每次 exec 的 args，回执按「分页全读」的形状给。 */
const mkControl = (calls, opts = {}) => ({
  whoHas: () => (opts.noHost ? [] : [{ id: 'h', host: 'dsh', caps: { has: () => true } }]),
  exec: async (hostId, cap, action, args) => {
    calls.push({ hostId, cap, action, args })
    if (opts.throw) throw new Error('sessions/read 失败（模拟）')
    const all = frames()
    const from = Number(args.fromSeq || 0)
    const page = all.slice(from, from + (args.limit || 400))
    return { ok: true, frames: page, count: page.length, nextFromSeq: null, badLines: 0 }
  },
})

// 1) 只给 tailFrames → 拒绝（不把它装成「这轮没说」），而且**一次 exec 都不发**
{
  const calls = []
  const r = createReplyReaderViaBridge({ control: mkControl(calls) })
  const v = await r.lastReply('s1', { tailFrames: 1200 })
  check('tailFrames 被拒绝', v.ok === false && v.code === 'REPLY_TAIL_TRUNCATION_REJECTED', v.ok ? 'ok?!' : v.code)
  check('拒绝时说清 maxFrames 是多少', /maxFrames|不支持只读尾部/.test(String(v.error)), String(v.error).slice(0, 40))
  check('拒绝时不发任何 bridge 请求', calls.length === 0, 'calls=' + calls.length)
  check('回执带 tailFrames 供定位', v.tailFrames === 1200, 'tailFrames=' + v.tailFrames)
  const view = r.view()
  check('计数把它记成失败而不是成功', view.failed === 1 && view.ok === 0, 'ok=' + view.ok + ' failed=' + view.failed)
}
// 2) 不给 tailFrames → 正常分页路径（maxFrames 由构造参数给）
{
  const calls = []
  const r = createReplyReaderViaBridge({ control: mkControl(calls), maxFrames: 4000, pageSize: 800 })
  const v = await r.lastReply('s2')
  check('正常路径拿到正文', v.ok === true && v.text === '回复正文', v.ok ? v.text : v.code)
  const a = calls[0] && calls[0].args
  check('走的是分页参数（有 fromSeq/limit，没有 tailFrames）',
    !!a && a.fromSeq === 0 && a.limit === 800 && a.tailFrames === undefined,
    a ? JSON.stringify({ fromSeq: a.fromSeq, limit: a.limit, tailFrames: a.tailFrames }) : 'no call')
}
// 3) tailFrames=0 / 负数 / 非数字 → 等同于没给（不该被闸挡住）
{
  for (const bad of [0, -1, 'abc', null, undefined]) {
    const calls = []
    const r = createReplyReaderViaBridge({ control: mkControl(calls) })
    const v = await r.lastReply('s3', { tailFrames: bad })
    check('tailFrames=' + String(bad) + ' 不触发截断闸', v.ok === true, v.ok ? 'ok' : v.code)
  }
}
// 4) 超上限 → 仍然是 REPLY_BRIDGE_FAILED（分页全读那条腿自己的闸），
//    不能被误报成「截断拒绝」—— 两个错因要分得开。
{
  const all = []
  for (let i = 1; i <= 9; i++) all.push({ seq: i, type: 'other', data: {} })
  const control = {
    whoHas: () => [{ id: 'h', host: 'dsh' }],
    exec: async (hostId, cap, action, args) => {
      const from = Number(args.fromSeq || 0)
      const page = all.slice(from, from + (args.limit || 400))
      const next = from + page.length < all.length ? from + page.length : null
      return { ok: true, frames: page, count: page.length, nextFromSeq: next, badLines: 0 }
    },
  }
  const r = createReplyReaderViaBridge({ control, maxFrames: 2, pageSize: 1 })
  const v = await r.lastReply('s4')
  check('超过 maxFrames 报 REPLY_BRIDGE_FAILED（不冒充截断拒绝）',
    v.ok === false && v.code === 'REPLY_BRIDGE_FAILED' && /超过上限/.test(String(v.error)), v.code)
}
// 5) 没有宿主声明 sessions → 失败外显（不退回文件）
{
  const calls = []
  const r = createReplyReaderViaBridge({ control: mkControl(calls, { noHost: true }) })
  const v = await r.lastReply('s5')
  check('没有宿主时是失败而不是「没说」', v.ok === false && v.code === 'REPLY_BRIDGE_FAILED', v.code)
  check('没有宿主时也说清楚原因', /没有任何宿主声明/.test(String(v.error)), String(v.error).slice(0, 30))
}

console.log(out.join('\n'))
console.log(failed === 0 ? '\n★ 全部通过' : '\n★ 失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
