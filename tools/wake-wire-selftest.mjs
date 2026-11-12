// 接线自检：derive → onEvents → waker，三段是不是真连上了
// 判据：不用网关、不用磁盘，用假 store 造帧，看回调收没收到「只有新事件」。
import { createEventDeriver } from '../src/events/derive.mjs'
import { createEventWaker } from '../src/events/wake.mjs'

let pass = 0, fail = 0
const bad = []
function ok (name, cond, d) {
  if (cond) { pass++; console.log('  ✓ ' + name + (d === undefined ? '' : '  ' + d)) }
  else { fail++; bad.push(name); console.log('  ✗ ' + name + (d === undefined ? '' : '  ' + d)) }
}

// ---------- 假 store：真 readAll，appendEvents 记忆化（模拟幂等账） ----------
function makeStore (envelopes) {
  const events = []
  const seen = new Set()
  return {
    readAll: () => envelopes.slice(),
    appendEvents (list) {
      const written = [], duplicate = []
      for (const e of list) {
        if (seen.has(e.id)) { duplicate.push(e.id); continue }
        seen.add(e.id); events.push(e); written.push(e.id)
      }
      return { ok: true, written, duplicate, conflict: [], rejected: [], code: null, message: '' }
    },
    pushError () {},
    _events: events,
  }
}

const t0 = 1_000_000
const env = (id, chatId, at) => ({
  event_id: id, source: 'onebot', type: 'message', chatId,
  created_at: new Date(at).toISOString(),
  payload: { sender: { nickname: 'n' + id }, message: [{ type: 'text', data: { text: 'msg-' + id } }] },
})

console.log('=== 一、回调收到的是「已关闭事件」 ===')
let now = t0 + 10 * 60 * 1000   // 10 分钟后：窗口早就关了
const store = makeStore([env('f1', 'group:1', t0), env('f2', 'group:1', t0 + 1000)])
const got = []
const waker = createEventWaker({ store, allow: { all: true } })
const deriver = createEventDeriver({
  store, now: () => now,
  onEvents: (evs) => { got.push(...evs); waker.compose(evs) },
})
const r1 = deriver.derive()
ok('derive 成功', r1.ok === true)
ok('回调被调用', got.length === 1, '收到 ' + got.length + ' 条')
ok('事件的 frameIds 覆盖两帧', got[0] && got[0].frameIds.length === 2, got[0] && JSON.stringify(got[0].frameIds))
ok('事件带 chatId', got[0] && got[0].chatId === 'group:1')
ok('已关闭（closedAt 有值）', got[0] && got[0].closedAt !== null)
ok('waker 拼出了 1 条投递请求', waker.view().ok === 1, JSON.stringify(waker.view().skipped))

console.log('=== 二、重放不再触发（幂等） ===')
const r2 = deriver.derive()
ok('第二次 derive 仍成功', r2.ok === true)
ok('回调没有第二次收到', got.length === 1, '仍是 ' + got.length + ' 条')
ok('waker 也只拼过 1 条', waker.view().ok === 1)

console.log('=== 三、新帧进来 → 只多一条 ===')
store.readAll = () => [env('f1', 'group:1', t0), env('f2', 'group:1', t0 + 1000), env('f3', 'group:2', t0 + 2000)]
now = t0 + 20 * 60 * 1000
const r3 = deriver.derive()
ok('第三次 derive 成功', r3.ok === true)
ok('回调收到第二条（新会话）', got.length === 2, '共 ' + got.length + ' 条')
ok('新事件 chatId 是 group:2', got[1] && got[1].chatId === 'group:2')

console.log('=== 四、白名单默认 none —— 拼得出来但不放行 ===')
const w2 = createEventWaker({ store })
const c2 = w2.compose(got)
ok('compose 仍 ok（拼是拼，投是投）', c2.ok === true)
ok('但 asks 为空', c2.asks.length === 0)
ok('记成 NOT_ALLOWED', (c2.skipped.NOT_ALLOWED || 0) === 2, JSON.stringify(c2.skipped))

console.log('=== 五、回调抛错不许把推导带下去 ===')
const store3 = makeStore([env('g1', 'group:9', t0)])
const d3 = createEventDeriver({
  store: store3, now: () => t0 + 10 * 60 * 1000,
  onEvents: () => { throw new Error('故意炸') },
})
const r5 = d3.derive()
ok('derive 仍然成功（回调的错被吞掉）', r5.ok === true)
// ★ stats 是**函数**（derive.mjs 返回 { stats: () => ({...}) }），不是对象 —— 一开始当对象取，取了个 undefined。
const st5 = typeof d3.stats === 'function' ? d3.stats() : {}
ok('错误记进了 lastError', st5.lastError && st5.lastError.code === 'ON_EVENTS_THREW', JSON.stringify(st5.lastError))
ok('事件确实写进账了', store3._events.length === 1, store3._events.length)

console.log('\n────────────────────────────────────────────')
console.log((fail === 0 ? '通过 ' : '失败 ') + pass + ' 项 · 失败 ' + fail + ' 项')
if (fail) { console.log('失败项：\n  - ' + bad.join('\n  - ')); process.exit(1) }
