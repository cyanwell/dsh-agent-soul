// reply-selftest —— events/reply.mjs 的断言
// 两类：① 纯函数 extractLastReply 喂假文本（边界全覆盖）
//       ② createReplyReader 读一个真会话（证明确实能读到生产数据）
import { extractLastReply, createReplyReader } from '../src/events/reply.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  if (cond) { pass++; return }
  fail++
  console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra).slice(0, 200) : ''))
}
const j = (o) => JSON.stringify(o)

// ---------- 造一段会话日志 ----------
const asst = (turn, texts, opts = {}) => j({
  type: 'assistant/message', seq: 100 + turn, time: 1000 + turn,
  data: { turn, step: 1, ...(opts.interrupted ? { interrupted: true } : {}),
    message: { role: 'assistant', content: [
      { type: 'reasoning', text: '这是思考过程，绝不能发出去' },
      ...texts.map((t) => ({ type: 'text', text: t })),
    ] } },
})
const tEnd = (turn, kind = 'completed') => j({ type: 'turn/end', seq: 200 + turn, time: 2000 + turn, data: { turn, reason: { kind } } })

// ① 正常的一轮
{
  const text = [asst(1, ['第一句']), tEnd(1)].join('\n')
  const r = extractLastReply(text)
  ok('正常一轮 ok', r.ok === true, r)
  ok('取到正文', r.text === '第一句', r.text)
  ok('turn 正确', r.turn === 1, r)
  ok('不含 reasoning', !String(r.text).includes('思考过程'), r.text)
}
// ② 没 turn/end = 还在跑 → 必须拒绝
{
  const r = extractLastReply([asst(1, ['半句话'])].join('\n'))
  ok('没 turn/end 拒绝', r.ok === false && r.code === 'REPLY_NO_TURN_END', r)
}
// ③ 多轮：只取最后一轮
{
  const text = [asst(1, ['旧']), tEnd(1), asst(2, ['新']), tEnd(2)].join('\n')
  const r = extractLastReply(text)
  ok('只取最后一轮', r.ok && r.turn === 2 && r.text === '新', r)
}
// ④ 没正常结束（aborted）→ 拒绝
{
  const text = [asst(1, ['说了一半']), tEnd(1, 'aborted')].join('\n')
  const r = extractLastReply(text)
  ok('没正常结束拒绝', r.ok === false && r.code === 'REPLY_NOT_COMPLETED', r)
}
// ⑤ 只有 reasoning，没 text → 拒绝（不能发空）
{
  const rec = j({ type: 'assistant/message', seq: 1, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '想' }] } } })
  const r = extractLastReply([rec, tEnd(1)].join('\n'))
  ok('只有思考时拒绝', r.ok === false && r.code === 'REPLY_EMPTY', r)
}
// ⑥ 坏行 → 拒绝，不能报「没说话」
{
  const text = [asst(1, ['好']), '{坏行', tEnd(1)].join('\n')
  const r = extractLastReply(text)
  ok('坏行拒绝', r.ok === false && r.code === 'REPLY_BAD_LINES', r)
  ok('坏行不报沉默', r.code !== 'REPLY_EMPTY', r.code)
}
// ⑦ interrupted 的那一步要被跳过
{
  const text = [asst(1, ['被打断的']), asst(1, ['真的'], { interrupted: true }), tEnd(1)].join('\n')
  const r = extractLastReply(text)
  ok('跳过 interrupted', r.ok && r.text === '被打断的', r)
}
// ⑧ 多个 text 块要拼起来
{
  const text = [asst(1, ['一', '二']), tEnd(1)].join('\n')
  const r = extractLastReply(text)
  ok('多块拼接', r.ok && r.text === '一\n二', r.text)
}
// ⑨ 指定 turn 只取那轮
{
  const text = [asst(1, ['旧']), tEnd(1), asst(2, ['新']), tEnd(2)].join('\n')
  const r = extractLastReply(text, { turn: 1 })
  ok('指定 turn', r.ok && r.turn === 1 && r.text === '旧', r)
}
// ⑩ 超长截断，chars 报原文长度
{
  const long = 'x'.repeat(100)
  const r = extractLastReply([asst(1, [long]), tEnd(1)].join('\n'), { maxText: 10 })
  ok('截断', r.ok && r.text.length === 10 && r.chars === 100 && r.truncated === true, { len: r.text && r.text.length, chars: r.chars })
}

// ---------- ② 读真会话 ----------
{
  const reader = createReplyReader({ sessionRoot: 'D:/AI/dsh/home/sessions' })
  const sid = 'session-0c90de16-48a6-44ed-907d-c77c6e1641e4'
  const r = reader.lastReply(sid)
  ok('真会话读得到', r.ok === true, r.ok ? null : r)
  if (r.ok) {
    ok('真会话 turn 是数字', Number.isFinite(r.turn), r.turn)
    ok('真会话正文非空', typeof r.text === 'string' && r.text.length > 0, r.chars)
    ok('真会话正文不含 reasoning 标记', !r.text.includes('type":"reasoning'), null)
  }
  const v = reader.view()
  ok('读数有 reads', v.reads >= 1, v)

  // 不存在的会话必须报 error，不能报「没说话」
  const bad = reader.lastReply('session-00000000-0000-0000-0000-000000000000')
  ok('不存在的会话报错', bad.ok === false && bad.code === 'REPLY_NO_SESSION_FILE', bad)
}

console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + ' · ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
