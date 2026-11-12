// 端到端自检：一条帧 → 事件 → 投递请求 → 控制通道 exec
// 这是整条链路唯一不需要真网关、真 DSH 就被完整跑一遍的地方。
// 假 hub 站在宿主的位置：它收到的 exec 就是 v4 真的要发出去的东西。
import { createEventDeriver } from '../src/events/derive.mjs'
import { createEventWaker } from '../src/events/wake.mjs'
import { createWakeDeliverer } from '../src/events/deliver.mjs'
import { createSessionDispatch } from '../src/organs/session-dispatch.mjs'

let pass = 0, fail = 0
const bad = []
function ok (name, cond, d) {
  if (cond) { pass++; console.log('  ✓ ' + name + (d === undefined ? '' : '  ' + d)) }
  else { fail++; bad.push(name); console.log('  ✗ ' + name + (d === undefined ? '' : '  ' + d)) }
}
function eq (name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got)) }

// ---------- 假 hub：站在宿主位置，记录 v4 真发出去的每条 exec ----------
function fakeHub (behaviour = {}) {
  const calls = []
  return {
    calls,
    canDo: (cap) => (cap === 'session'
      ? [{ id: 'host-fake', host: 'dsh', at: Date.now(), caps: ['session'], stubs: [] }]
      : []),
    snapshot: () => [{ id: 'host-fake', host: 'dsh', at: Date.now(), caps: ['session'], stubs: [] }],
    exec: async (hostId, cap, action, args) => {
      calls.push({ hostId, cap, action, args })
      // ★ 按**真实宿主**的形状抛：bridge 的 execFailure 给 { stage, error:'[stage:<code>] …' }。
      //   一开始我只设了 e.code 且消息里没标签，于是被归成 HOST_ERROR —— 是测试造得不像，不是代码错。
      if (behaviour.throwOn === action) {
        const st = behaviour.stage || 'not-found'
        throw Object.assign(new Error('[stage:' + st + '] 宿主说不行'), { stage: st })
      }
      if (action === 'resolve') return { ok: true, chatId: args.chatId, sessionId: 'session-0c90de16-48a6' }
      if (action === 'followup') return { delivered: true, sessionId: args.sessionId, target: args.sessionId }
      if (action === 'steer') return { delivered: true, sessionId: args.sessionId }
      throw new Error('不认识的动作 ' + action)
    },
  }
}

// ---------- 假 store ----------
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
const env = (id, chatId, at, nick, text) => ({
  event_id: id, source: 'onebot', type: 'message', chatId,
  created_at: new Date(at).toISOString(),
  payload: { user_id: 1001, sender: { nickname: nick }, message: [{ type: 'text', data: { text } }] },
})

console.log('=== 一、整条链：两帧 → 一次 exec 对 ===')
{
  const store = makeStore([
    env('f1', 'group:661580035', t0, '张三', '在吗'),
    env('f2', 'group:661580035', t0 + 1000, '李四', '在的'),
  ])
  const hub = fakeHub()
  const dispatch = createSessionDispatch({ hub })
  const waker = createEventWaker({ store, allow: { all: true } })
  const deliverer = createWakeDeliverer({ dispatch, enabled: true })
  const deriver = createEventDeriver({
    store, now: () => t0 + 60 * 60 * 1000,
    onEvents: (evs) => {
      const r = waker.compose(evs)
      if (r && r.ok && r.asks.length) Promise.resolve(deliverer.deliver(r.asks)).catch(() => {})
    },
  })

  deriver.derive()
  await new Promise((res) => setTimeout(res, 120))

  eq('宿主收到两次 exec', hub.calls.length, 2, JSON.stringify(hub.calls.map((c) => c.action)))
  eq('第一次是 resolve', hub.calls[0] && hub.calls[0].action, 'resolve')
  eq('resolve 的 cap 是 session', hub.calls[0] && hub.calls[0].cap, 'session')
  eq('resolve 带的是 chatId', hub.calls[0] && hub.calls[0].args.chatId, 'group:661580035')
  eq('第二次是 followup', hub.calls[1] && hub.calls[1].action, 'followup')
  eq('followup 用 resolve 回来的 sessionId', hub.calls[1] && hub.calls[1].args.sessionId, 'session-0c90de16-48a6')
  eq('followup 的正文按帧顺序拼好', hub.calls[1] && hub.calls[1].args.text, '张三：在吗\n李四：在的')
  eq('deliverer 记成投了 1 条', deliverer.view().delivered, 1)
  eq('dispatch 也记了 1 次 followup', dispatch.view().counts.followup, 1)
}

console.log('=== 二、宿主说没有这个会话 → 不投，记 NOT_FOUND ===')
{
  const store = makeStore([env('g1', 'group:404', t0, '王五', '有人吗')])
  const hub = fakeHub({ throwOn: 'resolve', stage: 'not-found' })
  const dispatch = createSessionDispatch({ hub })
  const waker = createEventWaker({ store, allow: { all: true } })
  const deliverer = createWakeDeliverer({ dispatch, enabled: true })
  const deriver = createEventDeriver({
    store, now: () => t0 + 60 * 60 * 1000,
    onEvents: (evs) => {
      const r = waker.compose(evs)
      if (r && r.ok && r.asks.length) Promise.resolve(deliverer.deliver(r.asks)).catch(() => {})
    },
  })
  deriver.derive()
  await new Promise((res) => setTimeout(res, 120))
  eq('只调了 resolve', hub.calls.map((c) => c.action), ['resolve'])
  eq('记成投了 0 条', deliverer.view().delivered, 0)
  eq('原因是 NOT_FOUND', deliverer.view().skipped.NOT_FOUND, 1)
}

console.log('=== 三、白名单没放行 → 一条 exec 都不发 ===')
{
  const store = makeStore([env('h1', 'group:999', t0, '某人', 'hi')])
  const hub = fakeHub()
  const dispatch = createSessionDispatch({ hub })
  const waker = createEventWaker({ store })   // 默认 none
  const deliverer = createWakeDeliverer({ dispatch, enabled: true })
  const deriver = createEventDeriver({
    store, now: () => t0 + 60 * 60 * 1000,
    onEvents: (evs) => {
      const r = waker.compose(evs)
      if (r && r.ok && r.asks.length) Promise.resolve(deliverer.deliver(r.asks)).catch(() => {})
    },
  })
  deriver.derive()
  await new Promise((res) => setTimeout(res, 80))
  eq('宿主一次都没被打扰', hub.calls.length, 0)
  eq('waker 记了 NOT_ALLOWED', waker.view().skipped.NOT_ALLOWED, 1)
}

console.log('=== 四、投递关着 → 拼得出来，但一条 exec 都不发 ===')
{
  const store = makeStore([env('i1', 'group:1', t0, 'a', 'b')])
  const hub = fakeHub()
  const dispatch = createSessionDispatch({ hub })
  const waker = createEventWaker({ store, allow: { all: true } })
  const deliverer = createWakeDeliverer({ dispatch, enabled: false })
  const deriver = createEventDeriver({
    store, now: () => t0 + 60 * 60 * 1000,
    onEvents: (evs) => {
      const r = waker.compose(evs)
      if (r && r.ok && r.asks.length) Promise.resolve(deliverer.deliver(r.asks)).catch(() => {})
    },
  })
  deriver.derive()
  await new Promise((res) => setTimeout(res, 80))
  eq('waker 拼出来了', waker.view().ok, 1)
  eq('但宿主没被调', hub.calls.length, 0)
}

console.log('=== 五、重放不重复叫醒 ===')
{
  const store = makeStore([env('j1', 'group:1', t0, 'a', 'b')])
  const hub = fakeHub()
  const dispatch = createSessionDispatch({ hub })
  const waker = createEventWaker({ store, allow: { all: true } })
  const deliverer = createWakeDeliverer({ dispatch, enabled: true })
  const deriver = createEventDeriver({
    store, now: () => t0 + 60 * 60 * 1000,
    onEvents: (evs) => {
      const r = waker.compose(evs)
      if (r && r.ok && r.asks.length) Promise.resolve(deliverer.deliver(r.asks)).catch(() => {})
    },
  })
  deriver.derive()
  await new Promise((res) => setTimeout(res, 100))
  const after1 = hub.calls.length
  deriver.derive()
  deriver.derive()
  await new Promise((res) => setTimeout(res, 100))
  eq('第一次发了 resolve+followup', after1, 2)
  eq('重放没有再发', hub.calls.length, 2)
}

console.log('\n────────────────────────────────────────────')
console.log((fail === 0 ? '通过 ' : '失败 ') + pass + ' 项 · 失败 ' + fail + ' 项')
if (fail) { console.log('失败项：\n  - ' + bad.join('\n  - ')); process.exit(1) }
