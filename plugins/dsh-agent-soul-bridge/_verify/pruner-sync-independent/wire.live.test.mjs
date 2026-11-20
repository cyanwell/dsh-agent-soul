/**
 * 桥 · prunerLive=true 的**线上**路径（独立复核，2026-11-11）
 * ==========================================================
 * 跑法（桥目录）：
 *   node --import "file:///D:/AI/dsh-tools/dsh-yanqing-pruner/test/register.mjs" \
 *        --test _verify/pruner-sync-independent/wire.live.test.mjs
 *
 * 这份测的是别人没测的那一段：**exec → handleExec → runExec → 适配器 → 真 applyDrops → result 帧**。
 * （原 adapter.test.mjs 直接调 runTargetedCleanup；原 wire-refusal.test.mjs 只覆盖桩态。）
 *
 * 两条前提说明：
 *   ① 走的是临时端口，不碰 7310，不连 DSH / QQ。
 *   ② 桥在源码目录里 import('dsh-yanqing-pruner') 会失败（没有 node_modules）——
 *      所以这条用例顺带证明：模块通道拿不到时，agent.ctx 通道仍然能把活干完。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

import { apply } from '../../index.js'

const SOUL_WS = 'D:/AI/agent-soul/src/control/ws.mjs'
const PRUNER = 'file:///D:/AI/dsh-tools/dsh-yanqing-pruner/index.js'
const SID = 'session-wire-indep'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const prunerMod = await import(PRUNER)
const Yanqing = prunerMod.default
const BIG = (t) => 'HEAD|' + t + '|' + 'x'.repeat(2600) + 'MID_' + t + '|' + 'y'.repeat(2600) + '|TAIL'

async function openServer () {
  const { accept } = await import(pathToFileURL(path.join(path.resolve(SOUL_WS))).href)
  const conns = []
  const server = http.createServer((req, res) => { res.writeHead(404); res.end() })
  server.on('upgrade', (req, socket) => {
    const c = accept(req, socket)
    if (c) conns.push(c)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: 'ws://127.0.0.1:' + server.address().port + '/control',
    conns,
    close: () => { for (const c of conns) { try { c.close() } catch {} } return new Promise((r) => server.close(() => r())) },
  }
}

function mkTemp (t) {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yq-wire-indep-')))
  assert.ok(real.startsWith(fs.realpathSync(os.tmpdir())))
  prunerMod.__setFixPaths({ cmd: path.join(real, 'cmd.jsonl'), rcpt: path.join(real, 'rcpt.jsonl') })
  t.after(() => { try { fs.rmSync(real, { recursive: true, force: true }) } catch {} })
  return real
}

function mkPruner () {
  const p = Object.create(Yanqing.prototype)
  p.config = Object.freeze({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
  p.ctx = { tokenMeter: { estimateMessage: () => 1 } }
  p.__yqQueue = null; p.__yqCursor = 0; p.__yqSid = ''; p.__yqForced = null; p.__yqForcedKeys = null
  p.__yqPendingPlan = null; p.__yqBlocksBySeq = null; p.__yqAllowed = null; p.__yqSeenSids = new Set()
  p.__yqLastTurn = new Map()
  p.__yqAutoCfg = { minPrunableChars: 60000, cooldownTurns: 20 }
  p.__yqStats = { calls: 0, triggered: 0, lastPrunable: 0, lastTurn: 0, lastSid: '', started: '', updated: '' }
  p.__yqFlushStats = () => {}
  return p
}

function mkSession (id, items) {
  const events = new Map()
  const nodes = new Set()
  const appends = []
  let next = 8300
  for (const it of items) {
    const cid = it.callId || ('call-' + it.seq)
    if (it.kind === 'call') events.set(it.seq, { type: 'tool/call', seq: it.seq, data: { turn: 1, step: 1, callId: cid, name: 'bash', arguments: '{}' } })
    else events.set(it.seq, { type: 'tool/result', seq: it.seq, data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: cid }, toolCallId: cid, content: [{ type: 'tool-result', toolCallId: cid, content: [{ type: 'text', text: it.text }] }] } } })
    nodes.add(it.seq)
  }
  return {
    session: {
      id, turn: 1, surface: { nodes },
      eventAt: (s) => events.get(Number(s)),
      append (type, data, opts) {
        const seq = next; next += 1
        appends.push({ type, seq, opts: opts || null })
        if (opts && opts.surfaceOp && opts.surfaceOp.op === 'replace') {
          for (let s = Number(opts.surfaceOp.startSeq); s <= Number(opts.surfaceOp.endSeq); s += 1) nodes.delete(s)
        }
        events.set(seq, { type, seq, data })
        if (type !== 'compaction/prune') nodes.add(seq)
        return { seq }
      },
    },
    events, nodes, appends,
  }
}

function makeCtx (agent) {
  const svc = { toolResultPruner: agent.pruner }
  return {
    // 根层拿不到 toolResultPruner（与生产一致：服务在 preset 的 agent ctx 上）
    get (n) {
      if (n === 'agents') return { get: (id) => (id === agent.session.id ? { session: agent.session, ctx: { get: (s) => svc[s] } } : undefined) }
      return undefined
    },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
}

test('线上：prunerLive=true 时 exec 真的走适配器，result 帧带回执（含重放与失败路径）', async (t) => {
  const temp = mkTemp(t)
  const srv = await openServer()
  t.after(async () => { await srv.close(); await sleep(80) })

  const fx = mkSession(SID, [
    { seq: 501, kind: 'result', callId: 'c501', text: BIG('OUT') },
    { seq: 510, kind: 'call', callId: 'c510' },
    { seq: 511, kind: 'result', callId: 'c510', text: BIG('IN1') },
    { seq: 512, kind: 'result', callId: 'c512', text: BIG('IN2') },
    { seq: 520, kind: 'result', callId: 'c520', text: BIG('OUT2') },
  ])
  const pruner = mkPruner()
  const agent = { session: fx.session, pruner }

  apply(makeCtx(agent), { url: srv.url, pingMs: 0, statePerTurn: false, log: false, prunerLive: true })
  await sleep(450)
  assert.equal(srv.conns.length, 1, '桥没连上测试服务器')
  const conn = srv.conns[0]
  const results = []
  conn.onmessage = (raw) => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (m && m.type === 'result') results.push(m)
  }

  // ① 正常一次
  conn.send({ type: 'exec', id: 'w1', cap: 'pruner', action: 'targeted-cleanup',
    args: { sessionId: SID, targetSession: SID, opId: 'wire-1', startSeq: 510, endSeq: 512, reason: '线上复核' } })
  await sleep(400)
  const r1 = results.find((x) => x.id === 'w1')
  assert.ok(r1, '没有回执')
  assert.equal(r1.ok, true, JSON.stringify(r1))
  assert.equal(r1.data.framesAffected, 2, JSON.stringify(r1.data))
  assert.equal(r1.data.startSeq, 510)
  assert.equal(r1.data.endSeq, 512)
  assert.equal(r1.data.pointer, 'log:' + SID + '#seq=510')
  assert.ok(!('bytesAffected' in r1.data))
  assert.ok(fx.nodes.has(501) && fx.nodes.has(520), '区间外没动')
  assert.ok(!fx.nodes.has(511) && !fx.nodes.has(512))
  assert.ok(fs.existsSync(path.join(temp, 'rcpt.jsonl')), '回执落在临时目录')

  // ② 同 opId 再来 → 重放，不再动刀
  const n = fx.appends.length
  conn.send({ type: 'exec', id: 'w2', cap: 'pruner', action: 'targeted-cleanup',
    args: { sessionId: SID, targetSession: SID, opId: 'wire-1', startSeq: 510, endSeq: 512 } })
  await sleep(400)
  const r2 = results.find((x) => x.id === 'w2')
  assert.equal(r2.ok, true, JSON.stringify(r2))
  assert.equal(r2.data.replayed, true)
  assert.equal(r2.data.framesAffected, 2)
  assert.equal(fx.appends.length, n, '线上重放也不许新增 append')

  // ③ 目标会话不存在 → 失败回执里带 stage
  conn.send({ type: 'exec', id: 'w3', cap: 'pruner', action: 'targeted-cleanup',
    args: { sessionId: 'session-nope', targetSession: 'session-nope', opId: 'wire-3', startSeq: 1, endSeq: 2 } })
  await sleep(300)
  const r3 = results.find((x) => x.id === 'w3')
  assert.equal(r3.ok, false)
  assert.match(String(r3.error), /不在活的 agent 里/)
  // ★ F1（2026-11-11 修正）：stage 不再只活在进程内 —— 线上 result 帧必须
  //   ① 带稳定可解析的 [stage:<code>] 前缀（v4 的 stageOfError 直接认），
  //   ② 带结构化 stage 字段（只读字段的消费方也能用）。
  assert.match(String(r3.error), /^\[stage:no-target\] /, '线上回执必须带可解析的 stage 前缀')
  assert.equal(r3.stage, 'no-target', 'result 帧必须带结构化 stage 字段')
  assert.ok(!/token|secret|password|api[_-]?key/i.test(String(r3.error)), '失败回执不许泄露凭据字样')

  // ④ 不明 action → 拒绝（不改会话）
  const before = fx.appends.length
  conn.send({ type: 'exec', id: 'w4', cap: 'pruner', action: 'drop-all', args: { sessionId: SID, opId: 'x', startSeq: 1, endSeq: 2 } })
  await sleep(300)
  const r4 = results.find((x) => x.id === 'w4')
  assert.equal(r4.ok, false)
  assert.match(String(r4.error), /只认 action=targeted-cleanup/)
  assert.equal(fx.appends.length, before)
})
