// 单测：createReplyReaderViaBridge —— bridge 版回复读取
// ★ 关键：它必须复用 extractLastReply 的**同一套判据**，且失败要外显（不回「这轮没说」）
import { createReplyReaderViaBridge } from '../src/events/reply.mjs'

const out = []
let failed = 0
const check = (label, ok, extra) => {
  out.push((ok ? '  ✓ ' : '  ✗ ') + label + (extra === undefined ? '' : '   [' + extra + ']'))
  if (!ok) failed += 1
}

const framesFor = (opts = {}) => {
  const f = []
  f.push({ seq: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'hi' }] } } })
  f.push({ seq: 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'reasoning', text: '思考过程' }, { type: 'text', text: '回复正文' }] } } })
  if (opts.end !== false) f.push({ seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: opts.reason || 'completed' } } })
  return f
}

const mkControl = (frames, opts = {}) => ({
  exec: async () => {
    if (opts.throw) throw new Error('sessions/read 失败（模拟）')
    return { ok: true, frames, count: frames.length, nextFromSeq: null, badLines: 0 }
  },
  whoHas: () => [{ id: 'h', host: 'dsh' }],
})

// 1) 正常
{
  const r = createReplyReaderViaBridge({ control: mkControl(framesFor()) })
  const v = await r.lastReply('s1')
  check('正常一轮拿到正文', v.ok === true && v.text === '回复正文', v.ok ? v.text : v.code)
  check('不含 reasoning', v.ok && !String(v.text).includes('思考过程'))
  check('标了 viaBridge', r.viaBridge === true)
}
// 2) 没有 turn/end → 拒绝（不把半句当回复）
{
  const r = createReplyReaderViaBridge({ control: mkControl(framesFor({ end: false })) })
  const v = await r.lastReply('s1')
  check('没有 turn/end 时拒绝', v.ok === false && v.code === 'REPLY_NO_TURN_END', v.code)
}
// 3) 非 completed → 拒绝
{
  const r = createReplyReaderViaBridge({ control: mkControl(framesFor({ reason: 'aborted' })) })
  const v = await r.lastReply('s1')
  check('未正常结束时拒绝', v.ok === false && v.code === 'REPLY_NOT_COMPLETED', v.code)
}
// 4) bridge 抛错 → 带 code 的失败（不是「这轮没说」）
{
  const r = createReplyReaderViaBridge({ control: mkControl([], { throw: true }) })
  const v = await r.lastReply('s1')
  check('bridge 失败时给出 REPLY_BRIDGE_FAILED', v.ok === false && v.code === 'REPLY_BRIDGE_FAILED', v.code)
}
// 5) 0 帧 → 明确是「没读到」不是「没说」
{
  const r = createReplyReaderViaBridge({ control: mkControl([]) })
  const v = await r.lastReply('s1')
  check('0 帧时给出 REPLY_BRIDGE_EMPTY', v.ok === false && v.code === 'REPLY_BRIDGE_EMPTY', v.code)
}
// 6) 没有 control → 构造时就抛
{
  let err = null
  try { createReplyReaderViaBridge({}) } catch (e) { err = e }
  check('缺 control 时构造即抛', err !== null && /需要 control/.test(err.message), err && err.message.slice(0, 50))
}

console.log(out.join('\n'))
console.log(failed === 0 ? '\n★ 全部通过' : '\n★ 失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
