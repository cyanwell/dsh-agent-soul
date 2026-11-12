// huanqi-llm-selftest —— 换气语义层的自检（用假 LLM，不烧真 token）
import { analyzeContext, parseVerdict, framesToPromptText } from '../src/organs/huanqi-llm.mjs'

let pass = 0, fail = 0
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')) } else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')) } }

const mkFrames = (n) => Array.from({ length: n }, (_, i) => ({ seq: i + 1, type: 'user', text: '第 ' + (i + 1) + ' 句' }))

console.log('=== ① parseVerdict ===')
{
  const good = JSON.stringify({ polluted: true, ranges: [{ start: 3, end: 7, kind: 'loop', reason: '同一件事试了三次' }], keep: [1], confidence: 0.8 })
  const v = parseVerdict(good)
  ok('正常 JSON 能解析', v.ok && v.polluted === true, null)
  ok('区间正确', v.ranges[0].start === 3 && v.ranges[0].end === 7, JSON.stringify(v.ranges[0]))
  ok('confidence 保留', v.confidence === 0.8, v.confidence)

  const fenced = '```json\n' + good + '\n```'
  ok('带围栏也能解析', parseVerdict(fenced).ok === true, null)

  const noisy = '好的，我分析完了：\n' + good + '\n以上就是结果。'
  ok('前后有废话也能解析', parseVerdict(noisy).ok === true, null)

  ok('polluted:false + 空 ranges → 不报污染', parseVerdict(JSON.stringify({ polluted: false, ranges: [] })).polluted === false, null)
  ok('polluted:true 但 ranges 空 → 视为不污染', parseVerdict(JSON.stringify({ polluted: true, ranges: [] })).polluted === false, '这是对的：没给区间就没法清')

  ok('坏 JSON 返回 ok:false', parseVerdict('不是 JSON').ok === false, null)
  ok('空串返回 ok:false', parseVerdict('').ok === false, null)
  ok('非字符串返回 ok:false', parseVerdict(null).ok === false, null)

  // ★ 区间合并
  const two = parseVerdict(JSON.stringify({ polluted: true, ranges: [
    { start: 5, end: 9, kind: 'loop', reason: 'a' },
    { start: 8, end: 12, kind: 'dup', reason: 'b' },
  ] }))
  ok('重叠区间被合并成 1 个', two.ranges.length === 1, JSON.stringify(two.ranges))
  ok('合并后范围是 5-12', two.ranges[0].start === 5 && two.ranges[0].end === 12, null)
  ok('合并后保留了两种 kind', two.ranges[0].kinds.length === 2, two.ranges[0].kinds.join(','))

  const invalid = parseVerdict(JSON.stringify({ polluted: true, ranges: [{ start: 9, end: 3 }, { start: 'x', end: 2 }] }))
  ok('倒序/非数字区间被丢掉', invalid.ranges.length === 0, null)
}

console.log('=== ② framesToPromptText ===')
{
  const t = framesToPromptText([{ seq: 1, type: 'user', text: '你好' }, { seq: 2, type: 'assistant', text: '在' }])
  ok('带 seq 和 type', t.includes('[1] (user) 你好') && t.includes('[2] (assistant) 在'), null)
  const long = framesToPromptText([{ seq: 1, type: 'tool', text: 'x'.repeat(3000) }])
  ok('超长被截断', long.length < 1600 && long.includes('截断'), 'len=' + long.length)
  ok('缺 seq 用 ?', framesToPromptText([{ type: 'x', text: 'y' }]).includes('[?]'), null)
}

console.log('=== ③ analyzeContext（假 LLM）===')
{
  // 没 LLM
  const r1 = await analyzeContext({ llm: null, frames: mkFrames(3) })
  ok('没 LLM → 明确说做不到', r1.ok === false && r1.error.includes('没有可用的内嵌 LLM'), r1.error)

  // 没就绪
  const r2 = await analyzeContext({ llm: { ready: () => false, chat: async () => '{}' }, frames: mkFrames(3) })
  ok('没就绪 → 明确说没就绪', r2.ok === false && r2.error.includes('没就绪'), r2.error)

  // 正常
  let called = 0
  const fake = { ready: () => true, chat: async (msgs) => { called++; return JSON.stringify({ polluted: true, ranges: [{ start: 2, end: 3, kind: 'loop', reason: '重复' }], confidence: 0.9 }) } }
  const r3 = await analyzeContext({ llm: fake, frames: mkFrames(5) })
  ok('正常分析返回 ok', r3.ok === true, null)
  ok('polluted = true', r3.polluted === true, null)
  ok('analyzed = 5', r3.analyzed === 5, r3.analyzed)
  ok('模型被调用一次', called === 1, called)

  // 截断
  const r4 = await analyzeContext({ llm: fake, frames: mkFrames(100) })
  ok('超过 60 帧只取最近 60', r4.analyzed === 60, r4.analyzed)
  ok('dropped = 40', r4.dropped === 40, r4.dropped)

  // 模型抛错
  const bad = { ready: () => true, chat: async () => { throw new Error('网络炸了') } }
  const r5 = await analyzeContext({ llm: bad, frames: mkFrames(3) })
  ok('模型抛错 → ok:false 且带上错因', r5.ok === false && r5.error.includes('网络炸了'), r5.error)

  // 模型返回垃圾
  const junk = { ready: () => true, chat: async () => '我不知道' }
  const r6 = await analyzeContext({ llm: junk, frames: mkFrames(3) })
  ok('模型返回垃圾 → ok:false', r6.ok === false, r6.error)

  // chat 返回对象（兼容 {content}）
  const obj = { ready: () => true, chat: async () => ({ content: JSON.stringify({ polluted: false, ranges: [] }) }) }
  const r7 = await analyzeContext({ llm: obj, frames: mkFrames(3) })
  ok('chat 返回对象也能解析', r7.ok === true && r7.polluted === false, null)

  // 空帧
  const r8 = await analyzeContext({ llm: fake, frames: [] })
  ok('没帧 → ok:false', r8.ok === false && r8.error.includes('没有帧'), r8.error)
}

console.log('')
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + ' · ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)