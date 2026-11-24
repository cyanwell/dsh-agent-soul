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

/** Fake host follows sessions/read tail receipt schema. */
const mkControl = (calls, opts = {}) => ({
  whoHas: () => (opts.noHost ? [] : [{ id: 'h', host: 'dsh', caps: { has: () => true } }]),
  exec: async (hostId, cap, action, args) => {
    calls.push({ hostId, cap, action, args })
    if (opts.throw) throw new Error('sessions/read 失败（模拟）')
    const all = opts.empty ? [] : frames()
    return { ok: true, frames: all, count: all.length, total: all.length, nextFromSeq: null, badLines: 0, fromEnd: true, truncated: false, tailFrames: args.tailFrames }
  },
})

// 1) 长于旧 4,000-frame 上限的 session：bounded tail 找到最新完整 turn。
{
  const calls = []
  const total = 4138
  const tail = Array.from({ length: total }, (_, i) => ({ seq: i + 1, type: 'other', data: {} }))
  tail[total - 2] = { seq: total - 1, type: 'assistant/message', data: { turn: 7, message: { content: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: '尾部回复' }] } } }
  tail[total - 1] = { seq: total, type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } }
  const control = {
    whoHas: () => [{ id: 'h', host: 'dsh' }],
    exec: async (hostId, cap, action, args) => { calls.push({ hostId, cap, action, args }); return { ok: true, frames: tail, count: tail.length, total, nextFromSeq: null, badLines: 0, fromEnd: true, truncated: false, tailFrames: args.tailFrames, tailBytesUsed: 0 } },
  }
  const r = createReplyReaderViaBridge({ control })
  const v = await r.lastReply('long-session')
  check('4138帧 session 尾读可提取最新 completed turn', v.ok === true && v.text === '尾部回复' && v.turn === 7, v.ok ? v.text : v.code)
  check('尾读请求有界且单次', calls.length === 1 && calls[0].args.tailFrames === 8000, JSON.stringify(calls[0]?.args))
  check('尾读不泄露 reasoning', v.ok && !v.text.includes('hidden'))
  check('view 报告 tailFrames', r.view().tailFrames === 8000)
}
// A) A short, fully-read empty session is proven empty and may establish baseline turn 0.
{
  const noTurn = [{ seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } }]
  const control = { whoHas: () => [{ id: 'h', host: 'dsh' }], exec: async () => ({ ok: true, frames: noTurn, count: 1, total: 1, badLines: 0, fromEnd: true, truncated: false, tailFrames: 8000, tailBytesUsed: 0 }) }
  const r = createReplyReaderViaBridge({ control })
  const v = await r.lastReply('new-short-session')
  check('short empty session is proven complete', v.ok === false && v.code === 'REPLY_NO_TURN_END' && v.baselineEmpty === true && v.sessionFrames === 1, JSON.stringify({ code: v.code, baselineEmpty: v.baselineEmpty, sessionFrames: v.sessionFrames }))
}
// B) A tail window with no completed turn is not proof of an empty session.
{
  const noTurn = Array.from({ length: 8000 }, (_, i) => ({ seq: i + 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } }))
  const control = { whoHas: () => [{ id: 'h', host: 'dsh' }], exec: async (_host, _cap, _action, args) => ({ ok: true, frames: noTurn, count: noTurn.length, total: noTurn.length, badLines: 0, fromEnd: true, truncated: true, tailFrames: args.tailFrames, tailBytesUsed: 4 * 1024 * 1024 }) }
  const r = createReplyReaderViaBridge({ control })
  const v = await r.lastReply('old-no-turn')
  check('tail without complete turn does not claim empty baseline', v.ok === false && v.code === 'REPLY_BASELINE_UNPROVEN' && v.baselineEmpty !== true, v.code)
}
// 2) Byte tail 已截去旧 bytes，但 EOF 尾部有 completed turn：允许提取最新 turn。
{
  const control = { whoHas: () => [{ id: 'h', host: 'dsh' }], exec: async (_host, _cap, _action, args) => ({ ok: true, frames: frames(), count: 3, total: 3, badLines: 0, fromEnd: true, truncated: true, tailFrames: args.tailFrames, tailBytesUsed: 4 * 1024 * 1024 }) }
  const r = createReplyReaderViaBridge({ control })
  const v = await r.lastReply('byte-truncated-with-complete-turn')
  check('byte-truncated EOF tail with completed turn is usable', v.ok === true && v.turn === 1 && v.text === '回复正文', v.ok ? v.text : v.code)
}
// 3) Byte truncation with no turn/end cannot prove the session is empty.
{
  const noTurn = [{ seq: 9001, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } }]
  const control = { whoHas: () => [{ id: 'h', host: 'dsh' }], exec: async (_host, _cap, _action, args) => ({ ok: true, frames: noTurn, count: 1, total: 1, badLines: 0, fromEnd: true, truncated: true, tailFrames: args.tailFrames, tailBytesUsed: 4 * 1024 * 1024 }) }
  const r = createReplyReaderViaBridge({ control })
  const v = await r.lastReply('byte-truncated-no-turn')
  check('truncated no-turn tail is baseline-unproven', v.ok === false && v.code === 'REPLY_BASELINE_UNPROVEN' && v.baselineEmpty !== true, v.code)
}
// 3) tail 中存在坏行：拒绝，不把剩余帧包装成完整结果。
{
  const control = { whoHas: () => [{ id: 'h', host: 'dsh' }], exec: async () => ({ ok: true, frames: frames(), count: 3, total: 3, badLines: 1, fromEnd: true, truncated: false, tailFrames: 8000 }) }
  const r = createReplyReaderViaBridge({ control })
  const v = await r.lastReply('bad-lines')
  check('badLines tail fail-closed', v.ok === false && v.code === 'REPLY_BRIDGE_TRUNCATED', v.code)
}
// 4) Missing EOF proof / fromEnd marker: reject unknown host contract.
{
  const control = { whoHas: () => [{ id: 'h', host: 'dsh' }], exec: async () => ({ ok: true, frames: frames(), count: 3, total: 3, badLines: 0, tailFrames: 8000 }) }
  const r = createReplyReaderViaBridge({ control })
  const v = await r.lastReply('missing-proof')
  check('missing fromEnd proof fail-closed', v.ok === false && v.code === 'REPLY_BRIDGE_TRUNCATED', v.code)
}
// 5) tailFrames 超过 host cap 会由调用侧收敛到 20,000，并检查 host 的 truncation receipt。
{
  const calls = []
  const control = { whoHas: () => [{ id: 'h', host: 'dsh' }], exec: async (hostId, cap, action, args) => { calls.push(args); return { ok: true, frames: frames(), count: 3, total: 3, badLines: 0, fromEnd: true, truncated: true, tailBytesUsed: 4 * 1024 * 1024, tailFrames: 20000 } } }
  const r = createReplyReaderViaBridge({ control, tailFrames: 30000 })
  const v = await r.lastReply('over-cap')
  check('tailFrames request capped at 20000', calls[0]?.tailFrames === 20000, String(calls[0]?.tailFrames))
  check('capped EOF tail remains usable', v.ok === true && v.turn === 1, v.ok ? String(v.turn) : v.code)
}
// 6) Reader independently rejects incoherent receipt counters.
{
  for (const patch of [{ count: 2 }, { total: 0 }, { tailFrames: 7999 }]) {
    const control = { whoHas: () => [{ id: 'h', host: 'dsh' }], exec: async (_host, _cap, _action, args) => ({ ok: true, frames: frames(), count: patch.count ?? 3, total: patch.total ?? 3, badLines: 0, fromEnd: true, truncated: false, tailFrames: patch.tailFrames ?? args.tailFrames }) }
    const r = createReplyReaderViaBridge({ control })
    const v = await r.lastReply('bad-counters')
    check('inconsistent receipt counters fail closed', v.ok === false && v.code === 'REPLY_BRIDGE_RECEIPT_INVALID', v.code)
  }
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
