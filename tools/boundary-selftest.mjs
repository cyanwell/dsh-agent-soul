// boundary-selftest —— 长消息 / 空消息 / 超大回复的边界
// ============================================================================
// 为什么需要：正常路径已经验过很多次了，但**边界一次都没验**。
//   而边界坏了，表现是「她偶尔说半句话」或「偶尔不回」——
//   那种故障最难归因，因为它不像故障，像她今天状态不好。
//
// 验四样：
//   ① 正文超长时 wake 会截断（maxChars）
//   ② 回复超长时 reply 会截断（maxText），但 chars 报原文长度
//   ③ 空正文不进判定（不浪费一次投递）
//   ④ 只有纯符号的正文转不出段（明确拒绝，不是静默丢）
// ============================================================================
import { toMessages, toSegments } from '../src/events/format.mjs'
import { extractLastReply } from '../src/events/reply.mjs'

let pass = 0, fail = 0
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')) } else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')) } }

// ---------- ① 超长正文转段 ----------
console.log('=== ① 超长正文 ===')
{
  const long = '这是很长的一段话。'.repeat(2000)   // 1.8 万字
  const r = toMessages(long)
  ok('超长正文能转', r.ok === true, r.code)
  const chars = r.messages.reduce((n, m) => n + m.segments.reduce((k, s) => k + String((s.data && s.data.text) || '').length, 0), 0)
  ok('转出来没丢字', chars === long.length, chars + ' / ' + long.length)
  ok('段数不炸', r.messages.length <= 3, r.messages.length)
}

// ---------- ② 回复超长时截断但报原文长度 ----------
console.log('=== ② 超长回复 ===')
{
  const j = (o) => JSON.stringify(o)
  const body = 'x'.repeat(20000)
  const rec = j({ type: 'assistant/message', seq: 1, data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: body }] } } })
  const end = j({ type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  const r = extractLastReply([rec, end].join('\n'), { maxText: 8000 })
  ok('取到了', r.ok === true, r.code)
  ok('正文被截到 8000', r.text.length === 8000, r.text && r.text.length)
  ok('chars 报原文 20000', r.chars === 20000, r.chars)
  ok('truncated 标了 true', r.truncated === true, r.truncated)
}

// ---------- ③ 空正文 ----------
console.log('=== ③ 空正文 ===')
{
  ok('空串转段被拒', toSegments('').ok === false, null)
  ok('纯空白被拒', toSegments('   \n\t  ').ok === false, null)
  ok('[沉默] 被拒', toSegments('[沉默]').ok === false, null)
}

// ---------- ④ 只有符号 ----------
console.log('=== ④ 只有符号 ===')
{
  const r = toSegments('。。。！！！')
  ok('纯标点仍算文字（不该丢）', r.ok === true, r.ok ? 'ok' : r.code)
  const p = toSegments('<poke/>')
  ok('只有 poke 也算有效', p.ok === true && p.segments[0].type === 'poke', p.segments && p.segments.map((s) => s.type))
  const st = toSegments('<sticker:开心>')
  ok('只有 sticker 也算有效', st.ok === true && st.segments[0].type === 'sticker', st.segments && st.segments.map((s) => s.type))
}

// ---------- ⑤ 分隔符边界 ----------
console.log('=== ⑤ 分条边界 ===')
{
  const r1 = toMessages('|||')
  ok('全是分隔符 → 拒绝', r1.ok === false, r1.code)
  const r2 = toMessages('第一句|||')
  ok('末尾多余分隔符不产生空条', r2.ok && r2.messages.length === 1, r2.messages && r2.messages.length)
  const r3 = toMessages('a|||b|||c|||d|||e|||f')
  ok('超 3 条时截断到 3', r3.messages.length === 3, r3.messages.length)
}

console.log('')
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + ' · ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
