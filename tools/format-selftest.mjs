// format-selftest —— events/format.mjs 的断言
import { toSegments, toMessages, isSilence } from '../src/events/format.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; return } fail++; console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra).slice(0, 240) : '')) }
const types = (segs) => segs.map((s) => s.type).join(',')

// ① <at:QQ号> → 真 @（这是群里看到字面量的根因）
{
  const r = toSegments('<at:1901372960> 你好')
  ok('at 转段', r.ok && types(r.segments) === 'at,text', r)
  ok('at 的 qq 对', r.segments[0].data.qq === '1901372960', r.segments[0])
  // ★ 前导空格会被 trim 掉（QQ 消息开头有空格没意义）—— 断言要的是「文字还在」，
  //   不是「一个字节都没动」。2026-11-12 这条断言一开始写成带空格的，误报了一次。
  ok('at 后面的文字还在', r.segments[1].data.text === '你好', r.segments[1])
  ok('at 没有漏成字面量', !JSON.stringify(r.segments).includes('<at:'), r)
}
// ② <at:名字> 转不了 → 保留原文 + 记进 missedAt（不能静默吃掉）
{
  const r = toSegments('<at:小绪> 在吗')
  ok('名字形式保留原文', JSON.stringify(r.segments).includes('<at:小绪>'), r)
  ok('名字形式报 missedAt', r.missedAt.length === 1 && r.missedAt[0] === '小绪', r.missedAt)
}
// ③ <reply:456> → 引用段
{
  const r = toSegments('<reply:456>收到')
  ok('reply 转段', r.ok && types(r.segments) === 'reply,text', r)
  ok('reply 的 id 对', r.segments[0].data.id === '456', r.segments[0])
}
// ④ ||| 分条
{
  const r = toMessages('第一句|||第二句|||第三句')
  ok('分三条', r.ok && r.messages.length === 3, r.messages && r.messages.length)
  ok('第一条正文', r.messages[0].segments[0].data.text === '第一句', r.messages[0])
}
// ⑤ 超过 maxBubbles 截断
{
  const r = toMessages('a|||b|||c|||d|||e', { maxBubbles: 3 })
  ok('最多三条', r.messages.length === 3, r.messages.length)
}
// ⑥ <poke/> 转成独立段（2026-11-12 改：以前剥掉不发，群里永远戳不到人）
{
  const r = toSegments('戳一下<poke/>')
  const p = r.segments.find((s) => s.type === 'poke')
  ok('poke 转成段', r.ok && Boolean(p), r.segments.map((s) => s.type))
  ok('poke 不再记进 dropped', !r.dropped.includes('poke'), r.dropped)
  ok('poke 前后文字还在', r.segments.some((s) => s.type === 'text' && s.data.text === '戳一下'), r.segments.map((s) => s.type))
}
// ⑦ <voice> 转成独立的语音段（2026-11-12 改：以前只是"保留里面的话当文字"，那不是她要的效果）
{
  const r = toSegments('听我说<voice>这句话要用说的</voice>')
  // ★ 旧断言只查「文字还在不在」—— 而 voice 段里也有那段文字，所以改了行为它照样绿。
  //   新断言查**类型**，这才是真覆盖。
  const v = r.segments.find((s) => s.type === 'voice')
  ok('voice 转成独立段', Boolean(v), r.segments.map((s) => s.type))
  ok('voice 的正文对', v && v.data.text === '这句话要用说的', v)
  ok('voice 前面还有文字段', r.segments[0].type === 'text' && r.segments[0].data.text === '听我说', r.segments.map((s) => s.type))
}
// ⑦b 整段都是语音
{
  const r = toSegments('<voice>全是语音</voice>')
  ok('整段语音也是有效消息', r.ok === true && r.segments.length === 1 && r.segments[0].type === 'voice', r)
}
// ⑧ <sticker:标签> 转成独立段（2026-11-12 改：以前是剥掉不发，群里永远收不到表情）
{
  const r = toSegments('笑死<sticker:笑哭></sticker>')
  ok('sticker 转成段', r.ok && r.segments.some((s) => s.type === 'sticker'), r)
  const st = r.segments.find((s) => s.type === 'sticker')
  ok('sticker 的 tag 对', st && st.data.tag === '笑哭', st)
  // ★ 位置要在它出现的地方，不能全掉到末尾 —— 她写的位置是有意义的
  ok('sticker 在文字后面', r.segments[0].type === 'text' && r.segments[0].data.text === '笑死', r.segments.map((s) => s.type))
  ok('sticker 不再记进 dropped', !r.dropped.includes('sticker'), r.dropped)
}
// ⑧b 表情在中间：文字要切成前后两段
{
  const r = toSegments('前面<sticker:开心>后面')
  const order = r.segments.map((s) => s.type).join(',')
  ok('中间的表情把文字切成两段', order === 'text,sticker,text', order)
  ok('前段内容对', r.segments[0].data.text === '前面', r.segments[0])
  ok('后段内容对', r.segments[2].data.text === '后面', r.segments[2])
}
// ⑨ [沉默] → 不发
{
  const r = toSegments('[沉默]')
  ok('沉默不转段', r.ok === false && r.code === 'FORMAT_SILENT', r)
  ok('沉默判定', isSilence('[沉默]') && isSilence('') && isSilence('（沉默）'), null)
  ok('非沉默判定', !isSilence('你好'), null)
}
// ⑩ Markdown 洗掉（QQ 不渲染）
{
  const r = toSegments('**重点**要`注意`')
  ok('洗掉加粗', !JSON.stringify(r.segments).includes('**'), r)
  ok('洗掉反引号', !JSON.stringify(r.segments).includes('`'), r)
  ok('文字还在', JSON.stringify(r.segments).includes('重点'), r)
}
// ⑪ 纯图片标记 → 不假装发了图
{
  const r = toSegments('看这个![图](https://x/y.png)')
  ok('图片降级成文字', JSON.stringify(r.segments).includes('[图片]'), r)
  ok('图片记进 dropped', r.dropped.some((d) => d.startsWith('image:')), r.dropped)
}
// ⑫ 空 / 只有标记 → 明确拒绝
{
  const a = toSegments('')
  ok('空串拒绝', a.ok === false, a)
  // ★ 2026-11-12 改：只有表情**也是有效消息**（以前会被判空丢掉）。
  //   一句「笑死<sticker:笑哭>」本来就该发出去 —— 文字没了，表情还在。
  const b = toSegments('<sticker:x>')
  ok('只有表情也是有效消息', b.ok === true && b.segments.length === 1 && b.segments[0].type === 'sticker', b)
}
// ⑬ 真实场景：2026-11-12 03:51:04 那条的原文
{
  const real = '<at:1901372960> 闭环五步，我这边能看到的分两半：\n\n**第一半**是收和判。|||第二半才是投和回。'
  const r = toMessages(real)
  ok('真实文本能转', r.ok === true, r)
  ok('真实文本没有裸 at', !JSON.stringify(r.messages).includes('<at:'), r.messages)
  ok('真实文本分成两条', r.messages.length === 2, r.messages.length)
}

console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + ' · ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
