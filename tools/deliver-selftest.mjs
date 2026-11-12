// deliver.mjs 自检 —— 投递器（resolve → followup → 判回执）
// 判据：用假 dispatch，验「没开就不投、失败不进下一格、同一事件不重复投、回执不一致要拦」。
import { createWakeDeliverer } from '../src/events/deliver.mjs'

let pass = 0, fail = 0
const bad = []
function ok (name, cond, d) {
  if (cond) { pass++; console.log('  ✓ ' + name + (d === undefined ? '' : '  ' + d)) }
  else { fail++; bad.push(name); console.log('  ✗ ' + name + (d === undefined ? '' : '  ' + d)) }
}
function eq (name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got)) }

/** 假 dispatch：按调用顺序记账，可注入每步的结果。 */
function fakeDispatch (plan = {}) {
  const calls = []
  return {
    calls,
    resolve: async (a) => {
      calls.push(['resolve', a.chatId])
      const r = plan.resolve ? plan.resolve(a) : { ok: true, sessionId: 'sess-1' }
      if (plan.delayMs) await new Promise((res) => setTimeout(res, plan.delayMs))
      return r
    },
    followup: async (a) => {
      calls.push(['followup', a.sessionId, a.text])
      const r = plan.followup ? plan.followup(a) : { ok: true, delivered: true, sessionId: a.sessionId }
      if (plan.delayMs) await new Promise((res) => setTimeout(res, plan.delayMs))
      return r
    },
  }
}
const ask = (id, chatId, text) => ({ eventId: id, chatId, text: text || 'x' })

console.log('=== 一、默认不投 ===')
{
  const d = fakeDispatch()
  const del = createWakeDeliverer({ dispatch: d })
  const r = await del.deliver([ask('e1', 'group:1')])
  eq('返回 disabled', r.disabled, true)
  eq('一条 dispatch 都没调', d.calls.length, 0)
  eq('view 里 enabled=false', del.view().enabled, false)
}

console.log('=== 二、开朗之后的正常路径 ===')
{
  const d = fakeDispatch()
  const del = createWakeDeliverer({ dispatch: d, enabled: true })
  const r = await del.deliver([ask('e1', 'group:1', '你好')])
  eq('投成功 1 条', r.delivered, 1)
  eq('调用了 resolve + followup', d.calls.map((c) => c[0]), ['resolve', 'followup'])
  eq('resolve 用的是 chatId', d.calls[0][1], 'group:1')
  eq('followup 用的是 resolve 回来的 sessionId', d.calls[1][1], 'sess-1')
  eq('followup 带上了正文', d.calls[1][2], '你好')
  eq('view 里 delivered=1', del.view().delivered, 1)
  ok('view 里不含正文', !JSON.stringify(del.view()).includes('你好'))
}

console.log('=== 三、resolve 失败 → 不调 followup ===')
{
  const d = fakeDispatch({ resolve: () => ({ ok: false, code: 'NOT_FOUND' }) })
  const del = createWakeDeliverer({ dispatch: d, enabled: true })
  const r = await del.deliver([ask('e2', 'group:404')])
  eq('没投出去', r.delivered, 0)
  eq('只调了 resolve', d.calls.map((c) => c[0]), ['resolve'])
  eq('记成 NOT_FOUND', r.skipped.NOT_FOUND, 1)
}

console.log('=== 四、resolve 回 ok 但没 sessionId ===')
{
  const d = fakeDispatch({ resolve: () => ({ ok: true }) })
  const del = createWakeDeliverer({ dispatch: d, enabled: true })
  const r = await del.deliver([ask('e3', 'group:1')])
  eq('拒绝', r.skipped.RESOLVE_NO_SESSION, 1)
  eq('没调 followup', d.calls.map((c) => c[0]), ['resolve'])
}

console.log('=== 五、回执 sessionId 与请求不一致 → 拦下 ===')
{
  const d = fakeDispatch({ followup: () => ({ ok: true, delivered: true, sessionId: 'sess-OTHER' }) })
  const del = createWakeDeliverer({ dispatch: d, enabled: true })
  const r = await del.deliver([ask('e4', 'group:1')])
  eq('判成 SESSION_MISMATCH', r.skipped.SESSION_MISMATCH, 1)
  eq('不算投成功', r.delivered, 0)
}

console.log('=== 六、同一条事件不投两次 ===')
{
  const d = fakeDispatch()
  const del = createWakeDeliverer({ dispatch: d, enabled: true })
  await del.deliver([ask('same', 'group:1')])
  const r2 = await del.deliver([ask('same', 'group:1')])
  eq('第二次记成 ALREADY_DONE', r2.skipped.ALREADY_DONE, 1)
  eq('dispatch 只被调了两下（一 resolve 一 followup）', d.calls.length, 2)
}

console.log('=== 七、失败的事件可以重投（没被记住）===')
{
  let n = 0
  const d = fakeDispatch({ resolve: () => (++n === 1 ? { ok: false, code: 'NO_HOST' } : { ok: true, sessionId: 'sess-9' }) })
  const del = createWakeDeliverer({ dispatch: d, enabled: true })
  const r1 = await del.deliver([ask('retry', 'group:1')])
  eq('第一次失败', r1.delivered, 0)
  const r2 = await del.deliver([ask('retry', 'group:1')])
  eq('第二次成功（失败不占位）', r2.delivered, 1)
}

console.log('=== 八、串行：同一 chatId 不并发 ===')
{
  const order = []
  const d = {
    resolve: async (a) => { order.push('r-' + a.chatId); await new Promise((x) => setTimeout(x, 20)); return { ok: true, sessionId: 's-' + a.chatId } },
    followup: async (a) => { order.push('f-' + a.sessionId); return { ok: true, delivered: true, sessionId: a.sessionId } },
  }
  const del = createWakeDeliverer({ dispatch: d, enabled: true })
  await del.deliver([ask('a1', 'group:A'), ask('a2', 'group:A')])
  // 若并发：r-A r-A f-A f-A；串行：r-A f-A r-A f-A
  eq('同会话严格交替（不并发）', order, ['r-group:A', 'f-s-group:A', 'r-group:A', 'f-s-group:A'])
}

console.log('=== 九、热开关：中途关掉就不再投 ===')
{
  let on = true
  const d = fakeDispatch()
  const del = createWakeDeliverer({ dispatch: d, enabled: () => on })
  await del.deliver([ask('h1', 'group:1')])
  on = false
  const r = await del.deliver([ask('h2', 'group:1')])
  eq('关掉之后进 disabled', r.disabled, true)
  eq('调用次数没增加', d.calls.length, 2)
}

console.log('=== 十、没有 dispatch 时明确失败 ===')
{
  const del = createWakeDeliverer({ enabled: true })
  const r = await del.deliver([ask('n1', 'group:1')])
  eq('记成 NO_DISPATCH', r.skipped.NO_DISPATCH, 1)
  eq('view 说没有 dispatch', del.view().hasDispatch, false)
}

console.log('=== 十一、按判定模式分账 ===')
{
  const d = fakeDispatch()
  const del = createWakeDeliverer({ dispatch: d, enabled: true })
  await del.deliver([{ eventId: 'm1', chatId: 'group:1', text: 'x', mode: 'must' }])
  await del.deliver([{ eventId: 'm2', chatId: 'group:1', text: 'y', mode: 'interject' }])
  await del.deliver([{ eventId: 'm3', chatId: 'group:1', text: 'z' }])   // 没有 mode
  const v = del.view()
  eq('must 记 1', v.byMode.must, 1)
  eq('interject 记 1', v.byMode.interject, 1)
  eq('没有 mode 的记成 unknown', v.byMode.unknown, 1)
  eq('最后一条的 mode', v.lastMode, 'unknown')
  eq('三条都投出去了', v.delivered, 3)
}

console.log('=== 十二、链要清干净（不许无限长） ===')
{
  // ★ 第一版用 `if (p === undefined) chains.delete(k)` 清理，而 chains 里全是 Promise ——
  //   一条都删不掉。这条断言就是钉住它。
  const d = fakeDispatch()
  const del = createWakeDeliverer({ dispatch: d, enabled: true })
  for (let i = 0; i < 5; i++) {
    await del.deliver([{ eventId: 'c' + i, chatId: 'group:' + i, text: 'x' }])
  }
  eq('五个不同会话投完，没有挂着的链', del.view().pendingChains, 0)
  eq('五条都投出去了', del.view().delivered, 5)
}

console.log('\n────────────────────────────────────────────')
console.log((fail === 0 ? '通过 ' : '失败 ') + pass + ' 项 · 失败 ' + fail + ' 项')
if (fail) { console.log('失败项：\n  - ' + bad.join('\n  - ')); process.exit(1) }
