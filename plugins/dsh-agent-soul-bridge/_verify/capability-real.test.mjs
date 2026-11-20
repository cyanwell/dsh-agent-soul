/**
 * 能力接真测试（2026-11-21 重写）—— huanqi / pruner 各自的真契约
 *
 * 跑法：node --test _verify/capability-real.test.mjs
 *
 * ★★★ 为什么整份重写（而不是修补）：
 *   2026-11-20 那一版把两件事搞混了 —— 它把「换气」实现成 prune/measure，
 *   也就是**把 pruner 的活抄了一份挂到 huanqi 名下**。这次翻回协议才发现：
 *   · huanqi 的动作一直只有一个：**break-turn**（README 能力表、probe.mjs 都这么写）
 *   · pruner 的动作只有一个：**targeted-cleanup**，而且 v4 要的是带 pointer 的**原生回执**
 *   · context-surgeon 那条路给不出 pointer，已经用它自己的名字 cap='context' 在跑
 *   所以测试也按三件事分开测，不再互相顶替。
 *
 * 覆盖：
 *   huanqi ① break-turn 真的调 agent.cancel(cause.kind='hook', keepInbox=true) 并如实回执
 *          ② 空闲会话（status!=running）→ cancelled=false，不许笼统回 ok
 *          ③ keepInbox=false 原样透传
 *          ④ 缺 sessionId → bad-request（不挑默认会话兜底）
 *          ⑤ action=prune → bad-request（钉住「huanqi 不是另一个 pruner」）
 *   pruner ⑥ 合法请求但够不到活 pruner → 明确失败 no-pruner，且回显会话/区间/opId
 *          ⑦ 缺 sessionId → bad-request（判据没松）
 *          ⑧ action 写错 → bad-request
 *          ⑨ prunerLive=false → pruner/disabled，不执行
 *
 * 全部离线：临时端口 + 假 ctx + 假 agent，不连 7310、不起 DSH、不读写任何真实会话。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply } from '../index.js'

const SOUL_WS = 'D:/AI/agent-soul/src/control/ws.mjs'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function openServer () {
  const { accept } = await import(pathToFileURL(path.join(path.resolve(SOUL_WS))).href)
  const conns = []
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket) => {
    const conn = accept(req, socket)
    if (conn) conns.push(conn)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = 'ws://127.0.0.1:' + server.address().port + '/control'
  return {
    url,
    conns,
    close: () => {
      for (const c of conns) { try { c.close() } catch {} }
      return new Promise((r) => server.close(() => r()))
    },
  }
}

/**
 * 假 agent：只要 bridge 真正用到的那些成员。
 * ★ 多加一个成员就会让测试测到宿主不存在的行为 —— 所以刻意保持最小。
 */
function makeAgent (sid, { status = 'running' } = {}) {
  const cancelCalls = []
  const agent = {
    id: sid,
    status,
    session: { id: sid, eventAt: () => null, append: () => ({ seq: 1 }) },
    cancel (cause, options) {
      cancelCalls.push({ cause, options })
      this.status = 'idle'
    },
    followup () {},
  }
  return { agent, cancelCalls }
}

function makeCtx (opts = {}) {
  const sid = 'session-abc'
  const { agent, cancelCalls } = makeAgent(sid, opts)
  const services = {
    agents: {
      get: (id) => (String(id) === sid ? agent : null),
      roots: () => [agent],
    },
  }
  return {
    ctx: {
      get: (name) => services[name],
      effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    },
    agent,
    cancelCalls,
  }
}

async function withBridge (t, ctxOptions, cfg = {}) {
  const srv = await openServer()
  t.after(async () => { await srv.close(); await sleep(50) })
  const built = makeCtx(ctxOptions)
  apply(built.ctx, { url: srv.url, pingMs: 0, statePerTurn: false, log: false, ...cfg })
  await sleep(400)
  assert.equal(srv.conns.length, 1, '桥没连上测试服务器')
  const conn = srv.conns[0]
  const results = []
  conn.onmessage = (raw) => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (m && m.type === 'result') results.push(m)
  }
  return { conn, results, ...built }
}

async function exec (t, msg, opts, cfg) {
  const b = await withBridge(t, opts, cfg)
  b.conn.send(msg)
  await sleep(400)
  const r = b.results.find((x) => x.id === msg.id)
  assert.ok(r, '没有回执（id=' + msg.id + '）')
  return { r, ...b }
}

// ─────────────────────────── huanqi / break-turn ───────────────────────────

test('① huanqi/break-turn：真的用 cause.kind=hook 调 agent.cancel，默认 keepInbox', async (t) => {
  const { r, cancelCalls } = await exec(t, {
    type: 'exec', id: 'h1', cap: 'huanqi', action: 'break-turn', args: { sessionId: 'session-abc' },
  })
  assert.equal(r.ok, true, '应该成功：' + JSON.stringify(r))
  assert.equal(r.data.action, 'break-turn')
  assert.equal(r.data.via, 'agent.cancel', '必须走宿主自己的取消机制，不是自己造一套')
  assert.equal(r.data.cancelled, true, 'running 的会话该报「真的断了」')
  assert.equal(r.data.statusBefore, 'running')
  assert.equal(r.data.keepInbox, true, '默认保留队列')
  assert.equal(cancelCalls.length, 1, '必须真的调了一次 cancel')
  assert.equal(cancelCalls[0].cause.kind, 'hook')
  assert.ok(String(cancelCalls[0].cause.reason).includes('huanqi'), 'reason 要能追溯来源')
  assert.equal(cancelCalls[0].options.keepInbox, true)
})

test('② huanqi/break-turn：空闲会话 cancelled=false（cancel 是 no-op，不许笼统回 ok）', async (t) => {
  const { r } = await exec(t, {
    type: 'exec', id: 'h2', cap: 'huanqi', action: 'break-turn', args: { sessionId: 'session-abc' },
  }, { status: 'idle' })
  assert.equal(r.ok, true, '调用本身是合法的')
  assert.equal(r.data.cancelled, false, '本来就没在跑 → 必须如实说没断成什么')
  assert.equal(r.data.statusBefore, 'idle')
})

test('③ huanqi/break-turn：keepInbox=false 原样透传', async (t) => {
  const { r, cancelCalls } = await exec(t, {
    type: 'exec', id: 'h3', cap: 'huanqi', action: 'break-turn', args: { sessionId: 'session-abc', keepInbox: false },
  })
  assert.equal(r.ok, true)
  assert.equal(r.data.keepInbox, false)
  assert.equal(cancelCalls[0].options.keepInbox, false)
})

test('④ huanqi/break-turn：缺 sessionId → bad-request（不挑默认会话兜底）', async (t) => {
  const { r } = await exec(t, { type: 'exec', id: 'h4', cap: 'huanqi', action: 'break-turn', args: {} })
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('缺 args.sessionId'), '理由要明确：' + r.error)
})

test('⑤ huanqi：action=prune → bad-request（huanqi 不是另一个 pruner）', async (t) => {
  const { r, cancelCalls } = await exec(t, {
    type: 'exec', id: 'h5', cap: 'huanqi', action: 'prune', args: { sessionId: 'session-abc' },
  })
  assert.equal(r.ok, false, 'prune 不是 huanqi 的动作')
  assert.ok(String(r.error).includes('break-turn'), '错误里要指出唯一合法的动作：' + r.error)
  assert.equal(cancelCalls.length, 0, '参数不对时一步都不许动')
})

// ─────────────────────────── pruner / targeted-cleanup ───────────────────────────

test('⑥ pruner：够不到活 pruner → 明确失败 no-pruner，并回显会话/区间/opId', async (t) => {
  const { r } = await exec(t, {
    type: 'exec', id: 'p6', cap: 'pruner', action: 'targeted-cleanup',
    args: { sessionId: 'session-abc', opId: 'clean-6-ff', startSeq: 101, endSeq: 102 },
  })
  assert.equal(r.ok, false, '拿不到活实例时绝不伪造成功：' + JSON.stringify(r))
  // ★ 读 code 而不是 stage：stage 是粗桶（unsupported/unavailable），code 才是 <域>/<动作>
  const code = String(r.code || r.stage || '')
  assert.ok(code.includes('no-pruner'), '该报 no-pruner，实际=' + code + '｜' + r.error)
  assert.ok(String(r.error).includes('session-abc'), '失败帧要回显会话')
  assert.ok(String(r.error).includes('101–102'), '失败帧要回显区间')
  assert.ok(String(r.error).includes('clean-6-ff'), '失败帧要回显 opId')
})

test('⑦ pruner：缺 sessionId → bad-request（判据没松）', async (t) => {
  const { r } = await exec(t, {
    type: 'exec', id: 'p7', cap: 'pruner', action: 'targeted-cleanup', args: { opId: 'clean-7-gg', startSeq: 1, endSeq: 2 },
  })
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('缺 args.sessionId'), '回执里要有明确原因：' + r.error)
  assert.ok(!String(r.error).includes('未实现（桩）'), '不许再出现桩文案')
})

test('⑧ pruner：action 写错 → bad-request，且指出唯一合法动作', async (t) => {
  const { r } = await exec(t, {
    type: 'exec', id: 'p8', cap: 'pruner', action: 'prune', args: { sessionId: 'session-abc' },
  })
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('targeted-cleanup'), '要指出合法动作：' + r.error)
})

test('⑨ prunerLive=false → pruner/disabled，不执行也不伪造', async (t) => {
  const { r } = await exec(t, {
    type: 'exec', id: 'p9', cap: 'pruner', action: 'targeted-cleanup',
    args: { sessionId: 'session-abc', opId: 'clean-9-hh', startSeq: 101, endSeq: 102 },
  }, {}, { prunerLive: false })
  assert.equal(r.ok, false)
  // ★ 读 code 而不是 stage：stage 是粗桶（unsupported/unavailable），code 才是 <域>/<动作>
  const code = String(r.code || r.stage || '')
  assert.ok(code.includes('pruner/disabled'), '该报 pruner/disabled，实际=' + code + '｜' + r.error)
  assert.ok(String(r.error).includes('prunerLive=false'), '理由要能直接指到那个开关')
})
