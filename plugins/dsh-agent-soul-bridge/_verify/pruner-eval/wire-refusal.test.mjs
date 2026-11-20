/**
 * pruner 桩的**线上**行为测试（2026-11-10）
 *
 * 跑法：node --test _verify/pruner-eval/wire-refusal.test.mjs
 *
 * ★ 为什么还要一份线上测试：`pruner-stub.test.mjs` 测的是纯函数，
 *   而真正会被 v4 看到的是**穿过 exec → handleExec → sendResult 这一条链之后的 result 帧**。
 *   这两者之间隔着 Promise 链、错误捕获、帧序列化 —— 不测就等于没测。
 *
 * ★ 这个测试**绕过了 agent-soul hub 的桩拦截**（那层在派活前就拒，见 hub.mjs），
 *   直接对桥发 exec —— 正好覆盖「万一 meta.stubs 没被尊重」的那条路。
 *
 * ★★★ 2026-11-20 改写：pruner 已接真，所以「合法请求」在这里**不再是桩拒绝**，
 *   而是「假 ctx 里没有 agents 服务 → 找不到会话 → not-found」。断言从
 *   「必须回桩文案」改成「必须回**明确失败原因**，且绝不出现桩文案、绝不伪造成功载荷」。
 *   真正的成功路径见 _verify/capability-real.test.mjs。
 *
 * ★ 全部离线：临时端口 + 假 ctx，不连 7310、不起 DSH、不读不写任何真实会话。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply } from '../../index.js'

const SOUL_WS = 'D:/AI/agent-soul/src/control/ws.mjs'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 最小 server：只做握手 + 收发 JSON，不含 hub 的任何拦截逻辑。 */
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

/** 假 ctx：所有服务都不可用（桥必须降级而不是崩）。 */
function makeCtx () {
  return {
    get: () => undefined,
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
}

test('线上：pruner/targeted-cleanup 每条 exec 都回一条 ok:false，且带着请求原样回显', async (t) => {
  const srv = await openServer()
  t.after(async () => { await srv.close(); await sleep(50) })

  apply(makeCtx(), { url: srv.url, pingMs: 0, statePerTurn: false, log: false })
  await sleep(400)
  assert.equal(srv.conns.length, 1, '桥没连上测试服务器')
  const conn = srv.conns[0]

  const results = []
  conn.onmessage = (raw) => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (m && m.type === 'result') results.push(m)
  }

  const cases = [
    { id: 'c1', args: { sessionId: 'session-abc', targetSession: 'session-abc', opId: 'clean-1-aa', startSeq: 100, endSeq: 180 }, want: ['session-abc', '180', 'clean-1-aa'] },
    { id: 'c2', args: { opId: 'clean-2-bb', startSeq: 1, endSeq: 2 }, want: ['缺 args.sessionId', '请求不合法'] },
    { id: 'c3', args: { sessionId: 'session-abc', targetSession: 'session-other', opId: 'clean-3-cc', startSeq: 1, endSeq: 2 }, want: ['不一致'] },
    { id: 'c4', args: { sessionId: 'session-abc', opId: 'clean-4-dd', startSeq: 1.5, endSeq: 2 }, want: ['startSeq 不是整数'] },
  ]
  for (const c of cases) conn.send({ type: 'exec', id: c.id, cap: 'pruner', action: 'targeted-cleanup', args: c.args })
  await sleep(600)

  assert.equal(results.length, cases.length, '回执数量不对：' + JSON.stringify(results.map((r) => r.id)))
  for (const c of cases) {
    const r = results.find((x) => x.id === c.id)
    assert.ok(r, '第 ' + c.id + ' 条没有回执（v4 会判超时）')
    assert.equal(r.ok, false, '假 ctx 里没有 agents 服务，不该成功：' + JSON.stringify(r))
    assert.ok(!String(r.error).includes('未实现（桩）'), c.id + ' 还在回桩文案：' + r.error)
    for (const needle of c.want) assert.ok(String(r.error).includes(needle), c.id + ' 的回执里没有「' + needle + '」：' + r.error)
    assert.ok(!/\n/.test(String(r.error)), c.id + ' 的回执不是单行')
  }
})

test('线上：失败回执不带 data / framesAffected（不伪造影响帧数）', async (t) => {
  const srv = await openServer()
  t.after(async () => { await srv.close(); await sleep(50) })

  apply(makeCtx(), { url: srv.url, pingMs: 0, statePerTurn: false, log: false })
  await sleep(400)
  const conn = srv.conns[0]
  const results = []
  conn.onmessage = (raw) => {
    try { const m = JSON.parse(raw); if (m && m.type === 'result') results.push(m) } catch {}
  }
  conn.send({ type: 'exec', id: 'k1', cap: 'pruner', action: 'targeted-cleanup', args: { sessionId: 's', targetSession: 's', opId: 'o', startSeq: 1, endSeq: 9 } })
  await sleep(400)
  const r = results.find((x) => x.id === 'k1')
  assert.ok(r, '没有回执')
  assert.equal(r.ok, false)
  assert.equal(r.data, undefined, '★ 失败回执不该带 data（那会被误读成成功载荷）')
  assert.ok(!/framesAffected/.test(JSON.stringify(r)), '失败回执里出现了 framesAffected：' + JSON.stringify(r))
})
