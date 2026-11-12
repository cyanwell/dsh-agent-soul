// engage-selftest —— events/engage.mjs + decide 的插话开关
import { createEngage } from '../src/events/engage.mjs'
import { createEventDecider } from '../src/events/decide.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra) => { if (cond) { pass++; return } fail++; console.log('  ✗ ' + name + (extra ? ' → ' + JSON.stringify(extra).slice(0, 240) : '')) }

// ---------- 一、engage 本身 ----------
{
  let t = 1000
  const e = createEngage({ now: () => t, engageMs: 60000, maxTimes: 5 })
  e.noteReply('g1')
  t = 2000; e.noteReply('g1')
  let s = e.stateOf('g1')
  ok('记了两次说话', s.botReplyTimes.length === 2, s.botReplyTimes)
  ok('还没插过话', s.interjectTimes.length === 0, s.interjectTimes)
  ok('没加入话题时 engagedUntil=0', s.engagedUntil === 0, s.engagedUntil)

  t = 3000; e.noteInterject('g1')
  s = e.stateOf('g1')
  ok('插话记进 interjectTimes', s.interjectTimes.length === 1, s.interjectTimes)
  ok('插话同时也算说话', s.botReplyTimes.length === 3, s.botReplyTimes)

  t = 4000; const until = e.joinTopic('g1')
  s = e.stateOf('g1')
  ok('joinTopic 给了未来时间', until === 64000, until)
  ok('engagedUntil 生效', s.engagedUntil === 64000, s.engagedUntil)
  e.leaveTopic('g1')
  ok('leaveTopic 清掉', e.stateOf('g1').engagedUntil === 0, null)

  // 长度上限：只留最近的
  for (let i = 0; i < 10; i++) e.noteReply('g2')
  ok('时间戳列表有上限', e.stateOf('g2').botReplyTimes.length === 5, e.stateOf('g2').botReplyTimes.length)

  // 不同群互相隔离
  ok('群之间隔离', e.stateOf('g1').botReplyTimes.length !== e.stateOf('g2').botReplyTimes.length, null)

  const v = e.view()
  ok('view 有 counters', v.replies >= 3 && v.interjects === 1, v)
}

// ---------- 二、decide 的开关 ----------
// ★ 构造照抄 decide-selftest：decide() 吃的是**事件**，事件通过 frameIds 指向帧。
const SELF = 3937956599
const T0 = Date.UTC(2026, 10, 12, 6, 0, 0)   // 14:00 北京时间（不在静默时段）
const env = (id, segs, opt = {}) => ({
  event_id: id, source: 'onebot', type: 'message',
  chatId: opt.chatId || 'group:661580035',
  created_at: new Date(T0).toISOString(),
  payload: {
    post_type: 'message', message_type: 'group', group_id: 661580035,
    self_id: opt.selfId === undefined ? SELF : opt.selfId,
    user_id: opt.userId || 1001,
    sender: { nickname: opt.nick || '某人', card: opt.card || '' },
    message: segs,
  },
})
const evt = (id, frameIds) => ({ id, chatId: 'group:661580035', frameIds, openedAt: T0, closedAt: T0, windowMs: 5000 })
const txt = (s) => ({ type: 'text', data: { text: s } })
const atSeg = (qq) => ({ type: 'at', data: { qq: String(qq) } })
const mk = (frames, opts = {}) => createEventDecider({ store: { readAll: () => frames }, now: () => T0, ...opts })

// ① 不传 interject：就算 policy 给了 0.99 也不插
{
  const frames = [env('f1', [txt('今天天气怎么样')])]
  const d = mk(frames, { policy: { interjectChance: 0.99, minRelevance: 0 }, interject: false })
  const r = d.decide(evt('e1', ['f1']))
  ok('没开开关时不插话', r.ok && r.reply === false && r.mode === 'none', JSON.stringify({ reply: r.reply, mode: r.mode, why: r.reason }))
  ok('理由说插话关着', String(r.reason || '').includes('插话关着'), r.reason)
  ok('view 报 forcedOff', d.view().interjectForcedOff === true, d.view())
}
// ② 传了 interject 但没 engage：仍然不插（缺状态不能开）
{
  const frames = [env('f2', [txt('今天天气怎么样')])]
  const d = mk(frames, { policy: { interjectChance: 0.99, minRelevance: 0 }, interject: true })
  const r = d.decide(evt('e2', ['f2']))
  ok('缺 engage 时仍然不插', r.ok && r.reply === false, JSON.stringify({ reply: r.reply, why: r.reason }))
  ok('缺 engage 时 view 报 forcedOff', d.view().interjectForcedOff === true, d.view())
}
// ③ 传了 interject + engage，且群里真的在聊 → 能插话
{
  // ★ 第一次写这条时只造了 1 条消息，被判「群里没在聊」——那是**正确行为**，
  //   是测试造错了：policy 的 minRecentMessages 就是防「群里冷清时她自嗨」的。
  //   所以这里造 8 条不同的消息，让 recentTimes 足够长。
  const frames = []
  for (let i = 0; i < 8; i++) frames.push(env('f3_' + i, [txt('第 ' + i + ' 句闲聊内容不一样')]))
  frames.push(env('f3', [txt('今天天气真的很不错啊')]))
  const e = createEngage({ now: () => T0 })
  const d = mk(frames, {
    policy: { interjectChance: 1, minRelevance: 0, cooldownSec: 0, maxPerHour: 100, minRecentMessages: 3 },
    interject: true, engage: e,
  })
  const r = d.decide(evt('e3', ['f3']))
  ok('开关+状态齐了能插话', r.ok && r.reply === true && r.mode === 'interject', JSON.stringify({ reply: r.reply, mode: r.mode, why: r.reason }))
  ok('view 报没强制关', d.view().interjectForcedOff === false, d.view())
  ok('view 报 hasEngage', d.view().hasEngage === true, d.view())
}
// ④ 被 @ 时不受插话开关影响（must 永远优先）
{
  const frames = [env('f4', [atSeg(SELF), txt(' 在吗')])]
  const d = mk(frames, { interject: false })
  const r = d.decide(evt('e4', ['f4']))
  ok('@ 不受插话开关影响', r.ok && r.reply === true && r.mode === 'must', JSON.stringify({ reply: r.reply, mode: r.mode }))
}
// ⑤ 刹车：最近说太多 → 不插话
{
  const frames = []
  for (let i = 0; i < 8; i++) frames.push(env('f5_' + i, [txt('第 ' + i + ' 句闲聊内容不一样')]))
  frames.push(env('f5', [txt('随便聊点什么吧')]))
  const e = createEngage({ now: () => T0 })
  for (let i = 0; i < 20; i++) e.noteReply('661580035', T0 - 1000)
  const d = mk(frames, {
    policy: { interjectChance: 1, minRelevance: 0, burstMax: 5, burstWindowSec: 120 },
    interject: true, engage: e,
  })
  const r = d.decide(evt('e5', ['f5']))
  ok('刚说太多时被刹车', r.ok && r.reply === false, JSON.stringify({ reply: r.reply, why: r.reason }))
  ok('理由是说了太多', String(r.reason || '').includes('说了太多'), r.reason)
}

// ⑥ 私聊：不走群策略，直接 must
{
  // ★ 2026-11-12 实测发现的 bug：私聊被当成群走 decideGroupReply，
  //   第一句就判成 "none:插话关着" —— 他跟她说句话，她不理。
  const frames = [env('p1', [txt('在吗，问你个事')], { chatId: 'private:1901372960' })]
  const d = mk(frames, { interject: false })
  const r = d.decide({ id: 'ep1', chatId: 'private:1901372960', frameIds: ['p1'], openedAt: T0, closedAt: T0, windowMs: 5000 })
  ok('私聊直接 must', r.ok && r.reply === true && r.mode === 'must', JSON.stringify({ reply: r.reply, mode: r.mode, reason: r.reason }))
  ok('理由是私聊', r.reason === '私聊', r.reason)
  ok('私聊正文有内容', typeof r.text === 'string' && r.text.length > 0, r.text)
}
// ⑦ 私聊即使插话关着也要回（那是它跟群策略的关键区别）
{
  const frames = [env('p2', [txt('随便聊一句')], { chatId: 'private:1901372960' })]
  const d = mk(frames, { interject: false, policy: { interjectChance: 0 } })
  const r = d.decide({ id: 'ep2', chatId: 'private:1901372960', frameIds: ['p2'], openedAt: T0, closedAt: T0, windowMs: 5000 })
  ok('私聊不受插话开关影响', r.ok && r.reply === true, JSON.stringify({ reply: r.reply, reason: r.reason }))
}

// ⑧ notice → pokeTarget（「谁戳了她」的判据有五个条件，漏一个就记错人）
{
  // ★ 第一次写这段时用了 111 / 222 这种 3 位数字当 QQ 号 —— 而校验是 5-12 位，
  //   于是 notePokeNotice 一律返回空，五条断言全红，看起来像代码错了。
  //   **测试数据不合规，比代码错更常见，也更难看出来。**
  const e = createEngage({ now: () => T0 })
  const SELF = 3937956599
  const base = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: SELF, group_id: 661580035 }
  const POKER = 111111
  const SPEAKER = 777777
  // 正常：别人戳她
  ok('别人戳她 → 记下', e.notePokeNotice({ ...base, user_id: POKER, target_id: SELF }) === String(POKER), null)
  ok('pokeTarget 拿到他', e.pokeTarget('661580035') === String(POKER), e.pokeTarget('661580035'))
  // 戳的是别人（不是她）→ 不记
  ok('戳别人 → 不记', e.notePokeNotice({ ...base, user_id: 222222, target_id: 999999 }) === '', null)
  // 自己戳自己 → 不记
  ok('自己戳自己 → 不记', e.notePokeNotice({ ...base, user_id: SELF, target_id: SELF }) === '', null)
  // 不是 poke → 不记
  ok('别的 notify → 不记', e.notePokeNotice({ ...base, sub_type: 'input_status', user_id: 333333, target_id: SELF }) === '', null)
  // 不是 notice → 不记
  ok('message 事件 → 不记', e.notePokeNotice({ post_type: 'message', user_id: 444444, target_id: SELF }) === '', null)
  // 没群号（私聊）→ 不记
  ok('私聊没群号 → 不记', e.notePokeNotice({ ...base, group_id: undefined, user_id: 555555, target_id: SELF }) === '', null)
  // ★ 戳过之后：优先戳他（而不是最后说话的人）
  e.noteSpeaker('661580035', SPEAKER)
  ok('有戳过的人时优先戳他', e.pokeTarget('661580035') === String(POKER), '期望 ' + POKER + '，实际 ' + e.pokeTarget('661580035'))
  // 没戳过的群 → 退到最后说话的人
  e.noteSpeaker('910808035', 888888)
  ok('没戳过的群退到说话的人', e.pokeTarget('910808035') === '888888', e.pokeTarget('910808035'))
  // 两样都没有 → 空（不在猜）
  ok('都没有时返回空', e.pokeTarget('1131366732') === '', JSON.stringify(e.pokeTarget('1131366732')))
  // 非法 QQ 号不算
  ok('非法 QQ 号不记', e.notePokeNotice({ ...base, user_id: 'abc', target_id: SELF }) === '', null)
}

console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + ' · ' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)