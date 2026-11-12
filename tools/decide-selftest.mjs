// decide.mjs 自检 —— 「这条消息该不该回」
// 判据：喂假帧，验 must 的四种触发（被@ / 叫名字 / 引用她 / 主人@）和 none 的几条路。
import { createEventDecider } from '../src/events/decide.mjs'
import { decideGroupReply, policyFor, topicRelevance, inQuietHours, DEFAULT_GROUP_POLICY } from '../src/events/policy.mjs'

let pass = 0, fail = 0
const bad = []
function ok (n, c, d) {
  if (c) { pass++; console.log('  ✓ ' + n + (d === undefined ? '' : '  ' + d)) }
  else { fail++; bad.push(n); console.log('  ✗ ' + n + (d === undefined ? '' : '  ' + d)) }
}
function eq (n, g, w) { ok(n, JSON.stringify(g) === JSON.stringify(w), JSON.stringify(g)) }

const SELF = 1901372960
const T0 = Date.UTC(2026, 10, 11, 6, 0, 0)   // 14:00 北京时间（不在静默时段 1–8 点）

const env = (id, segs, opt = {}) => ({
  event_id: id, source: 'onebot', type: 'message',
  chatId: opt.chatId || 'group:661580035',
  created_at: new Date(opt.at == null ? T0 : opt.at).toISOString(),
  payload: {
    post_type: 'message', message_type: 'group', group_id: 661580035,
    self_id: opt.selfId === undefined ? SELF : opt.selfId,
    user_id: opt.userId || 1001,
    sender: { nickname: opt.nick || '某人', card: opt.card || '' },
    message: segs,
  },
})
const evt = (id, frameIds, chatId) => ({ id, chatId: chatId || 'group:661580035', frameIds, openedAt: T0, closedAt: T0, windowMs: 5000 })
const txt = (s) => ({ type: 'text', data: { text: s } })
const at = (qq) => ({ type: 'at', data: { qq: String(qq) } })

function mk (envelopes, opts = {}) {
  return createEventDecider({ store: { readAll: () => envelopes }, ...opts })
}

console.log('=== 一、policy.mjs 是原样搬来的，行为要对得上 ===')
ok('默认策略有 wakeWords', Array.isArray(DEFAULT_GROUP_POLICY.wakeWords), DEFAULT_GROUP_POLICY.wakeWords.join(','))
eq('静默时段（跨零点）', inQuietHours(2, [1, 8]), true)
eq('不在静默时段', inQuietHours(14, [1, 8]), false)
eq('静默时段（不跨零点）', inQuietHours(13, [12, 14]), true)
ok('相关度：提到「鱼」', topicRelevance(['今天吃鱼'], ['鱼'], 0) > 0, topicRelevance(['今天吃鱼'], ['鱼'], 0))
eq('相关度：无关话题', topicRelevance(['今天天气'], ['鱼'], 0), 0)
const pol = policyFor({}, null, '1')
eq('policyFor 带上默认值', typeof pol.interjectChance, 'number')

console.log('=== 二、must：被 @ ===')
{
  const frames = [env('f1', [at(SELF), txt(' 在吗')])]
  const r = mk(frames).decide(evt('e1', ['f1']))
  eq('reply', r.reply, true)
  eq('mode', r.mode, 'must')
  eq('reason', r.reason, '被 @')
  eq('mentions', r.mentions, 1)
  // ★ at 段在正文里保留「@了谁」—— 那是信息（表示这条提到了她），不是噪音。
  //   一开始我把期望写成「某人：在吗」，是测试错，不是代码错。
  eq('正文保留 @ 标记', r.text, '某人：@1901372960 在吗')
}

console.log('=== 三、@ 的是别人 —— 不是 must ===')
{
  const frames = [env('f2', [at(999999), txt(' @他 你好')])]
  const r = mk(frames).decide(evt('e2', ['f2']))
  eq('reply', r.reply, false)
  eq('mentions', r.mentions, 0)
}

console.log('=== 四、must：叫到 wakeWords ===')
{
  const frames = [env('f3', [txt('大肥鱼你在吗')])]
  const r = mk(frames).decide(evt('e3', ['f3']))
  eq('reply', r.reply, true)
  eq('mode', r.mode, 'must')
  ok('reason 提到叫到的词', r.reason.includes('大肥鱼'), r.reason)
}

console.log('=== 五、普通闲聊 —— 不回（插话强制关） ===')
{
  const frames = [env('f4', [txt('今天天气不错')])]
  const r = mk(frames).decide(evt('e4', ['f4']))
  eq('reply', r.reply, false)
  eq('mode', r.mode, 'none')
  eq('reason', r.reason, '插话关着')
}

console.log('=== 六、静默时段也挡不住 must ===')
{
  const quietAt = Date.UTC(2026, 10, 11, 19, 0, 0)   // 03:00 北京时间
  const frames = [env('f5', [at(SELF), txt(' 醒醒')], { at: quietAt })]
  const r = mk(frames).decide(evt('e5', ['f5']))
  eq('被 @ 照样回', r.reply, true)
}

console.log('=== 七、正文提取与 wake.mjs 一致 ===')
{
  const frames = [env('f6', [{ type: 'image', data: { file: 'x.png' } }])]
  eq('图片给 [图片]', mk(frames).decide(evt('e6', ['f6'])).text, '某人：[图片]')
  const frames2 = [env('f7', [{ type: 'markdown', data: { content: '[@甲](mqqapi://x) 你好' } }])]
  eq('markdown 剥链接', mk(frames2).decide(evt('e7', ['f7'])).text, '某人：@甲 你好')
}

console.log('=== 八、多帧合并的事件：任一帧 @ 就算 ===')
{
  const frames = [
    env('f8', [txt('随便说说')], { at: T0 }),
    env('f9', [at(SELF), txt(' 你说呢')], { at: T0 + 1000 }),
  ]
  const r = mk(frames).decide(evt('e8', ['f8', 'f9']))
  eq('reply', r.reply, true)
  ok('两帧都在正文里', r.text.includes('随便说说') && r.text.includes('你说呢'))
}

console.log('=== 九、拒绝路径 ===')
{
  const m = mk([])
  eq('没有事件', m.decide(null).code, 'BAD_EVENT')
  eq('没有 chatId', m.decide({ id: 'x', frameIds: ['a'] }).code, 'NO_CHAT')
  eq('没有 frameIds', m.decide({ id: 'x', chatId: 'c' }).code, 'NO_FRAMES')
  eq('帧找不到', m.decide({ id: 'x', chatId: 'c', frameIds: ['zzz'] }).code, 'FRAME_MISSING')
  eq('没有 store', createEventDecider({}).decide({ id: 'x', chatId: 'c', frameIds: ['a'] }).code, 'NO_STORE')
}

console.log('=== 十、统计与 view ===')
{
  const frames = [env('g1', [at(SELF), txt(' 1')]), env('g2', [txt('2')], { at: T0 + 1 })]
  const d = mk(frames)
  d.decide(evt('x1', ['g1']))
  d.decide(evt('x2', ['g2']))
  const v = d.view()
  eq('judged', v.judged, 2)
  eq('must', v.must, 1)
  eq('none', v.none, 1)
  ok('插话被强制关掉', v.interjectForcedOff === true)
}

console.log('=== 十一、传进来的 policy 里带 interjectChance 也必须被压成 0 ===')
{
  // ★ 这条是踩出来的：{ interjectChance: 0, ...policy } 会让配置里的 0.15 盖掉 0，
  //   于是插话其实一直开着，而 interjectForcedOff 还报 true —— 假的安全信号。
  const d = createEventDecider({ store: { readAll: () => [] }, policy: { interjectChance: 0.15, cooldownSec: 1 } })
  eq('interjectChance 被压成 0', d.view().interjectForcedOff, true)
  // 直接验行为：普通闲聊在插话关着时必须判 none
  const frames = [env('k1', [txt('今天天气不错')])]
  const d2 = createEventDecider({ store: { readAll: () => frames }, policy: { interjectChance: 0.99 } })
  const r = d2.decide(evt('e11', ['k1']))
  eq('就算配置给 0.99，也不插话', r.reply, false)
  eq('理由是插话关着', r.reason, '插话关着')
}

console.log('\n────────────────────────────────────────────')
console.log((fail === 0 ? '通过 ' : '失败 ') + pass + ' 项 · 失败 ' + fail + ' 项')
if (fail) { console.log('失败项：\n  - ' + bad.join('\n  - ')); process.exit(1) }
