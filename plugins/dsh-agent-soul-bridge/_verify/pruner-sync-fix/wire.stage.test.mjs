/**
 * F1 修正 · 线上 stage 回传（2026-11-11）
 * =====================================
 * 跑法（桥目录）：
 *   node --import "file:///D:/AI/dsh-tools/dsh-yanqing-pruner/test/register.mjs" --test _verify/pruner-sync-fix/wire.stage.test.mjs
 *
 * 缺陷（复核 F1）：线上 result 帧只有一句 error 字符串，stage 丢在进程内；
 *   v4 的 stageOfError() 只认 timeout / 「宿主不在」，其余一律记 transport-error。
 *
 * 修正后的契约（本文件逐条钉住）：
 *   · 失败帧：ok:false + error 以 '[stage:<code>] ' 开头 + 结构化 stage 字段；
 *   · code 来自适配器自报（no-target / no-pruner / opid-reused …）或兜底映射
 *     （stub / timeout / no-host / host-error）；
 *   · 成功帧不带 error/stage（不把成功包装成失败，反之亦然）；
 *   · 正文单行、隐去凭据键值对、限长；
 *   · **端到端**：v4 真 stageOfError()（createTargetedCleanup 那条路）必须把
 *     '[stage:no-target] …' 认成 no-target，而不是 transport-error。
 *
 * 全部离线：临时端口 + 假 ctx + 临时目录，不连 7310、不起 DSH、不动生产会话/回执。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

import { apply, execFailure, execStageOf } from '../../index.js'

const SOUL_WS = 'D:/AI/agent-soul/src/control/ws.mjs'
const V4 = 'file:///D:/AI/agent-soul/src/organs/cleanup.mjs'
const SID = 'session-stage-0001'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const prunerMod = await import('file:///D:/AI/dsh-tools/dsh-yanqing-pruner/index.js')
const Yanqing = prunerMod.default

async function openServer () {
  const { accept } = await import(pathToFileURL(path.resolve(SOUL_WS)).href)
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

const BIG = (t) => 'HEAD|' + t + '|' + 'x'.repeat(2600) + 'MID_' + t + '|' + 'y'.repeat(2600) + '|TAIL'

function mkTemp (t) {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yq-stage-')))
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
  p.__yqPendingPlan = null; p.__yqBlocksBySeq = null; p.__yqAllowed = null; p.__yqOpScope = null
  p.__yqSeenSids = new Set()
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
  let next = 9100
  for (const it of items) {
    const cid = it.callId || ('call-' + it.seq)
    if (it.kind === 'call') {
      events.set(it.seq, { type: 'tool/call', seq: it.seq, data: { turn: 1, step: 1, callId: cid, name: 'bash', arguments: '{}' } })
    } else {
      events.set(it.seq, { type: 'tool/result', seq: it.seq, data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: cid }, toolCallId: cid, content: [{ type: 'tool-result', toolCallId: cid, content: [{ type: 'text', text: it.text }] }] } } })
    }
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

/** 假 ctx：pruner 由 getPruner() 动态给（null = 三条通道都拿不到）。 */
function ctxWith (agent, getPruner) {
  const get = (n) => (n === 'toolResultPruner' ? (getPruner ? getPruner() : null) : undefined)
  return {
    get (n) {
      if (n === 'toolResultPruner') return get('toolResultPruner')
      if (n === 'agents') return { get: (id) => (id === agent.session.id ? { session: agent.session, ctx: { get } } : undefined) }
      return undefined
    },
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
  }
}

async function wire (t, { prunerLive, getPruner, fx }) {
  const srv = await openServer()
  t.after(async () => { await srv.close(); await sleep(60) })
  apply(ctxWith({ session: fx.session }, getPruner), { url: srv.url, pingMs: 0, statePerTurn: false, log: false, prunerLive })
  await sleep(450)
  assert.equal(srv.conns.length, 1, '桥没连上测试服务器')
  const conn = srv.conns[0]
  const results = []
  conn.onmessage = (raw) => {
    let m
    try { m = JSON.parse(raw) } catch { return }
    if (m && m.type === 'result') results.push(m)
  }
  const send = async (id, args, action = 'targeted-cleanup', cap = 'pruner') => {
    conn.send({ type: 'exec', id, cap, action, args })
    await sleep(330)
    const r = results.find((x) => x.id === id)
    assert.ok(r, '没有回执：' + id)
    return r
  }
  return { srv, conn, results, send }
}

const stageOf = (e) => (/^\[stage:([a-z][a-z0-9-]{0,39})\]/.exec(String(e)) || [])[1]

// ───────────── 线上：同一个桥实例走完五个阶段 ─────────────
test('F1 线上：no-target / no-pruner / 成功 / opid-reused / bad-request 的 stage 全部带回', async (t) => {
  mkTemp(t)
  const fx = mkSession(SID, [
    { seq: 50, kind: 'call', callId: 'c50' },
    { seq: 51, kind: 'result', callId: 'c50', text: BIG('E') },
    { seq: 52, kind: 'result', callId: 'c52', text: BIG('F') },
  ])
  let current = null
  const w = await wire(t, { prunerLive: true, getPruner: () => current, fx })

  // ① 目标会话不存在 → no-target
  let appends = fx.appends.length
  const r1 = await w.send('s1', { sessionId: 'session-nope', targetSession: 'session-nope', opId: 'stage-1', startSeq: 1, endSeq: 2 })
  assert.equal(r1.ok, false)
  assert.equal(r1.stage, 'no-target', 'result 帧必须有结构化 stage')
  assert.match(String(r1.error), /^\[stage:no-target\] /, 'error 必须以稳定前缀开头')
  assert.equal(stageOf(r1.error), 'no-target', '前缀要能被正则解析出来')
  assert.equal(r1.data, undefined, '失败帧不许带 data')
  assert.equal(fx.appends.length, appends, '失败路径零写入')

  // ② 有 agent、三条通道都拿不到 pruner → no-pruner
  const r2 = await w.send('s2', { sessionId: SID, targetSession: SID, opId: 'stage-2', startSeq: 51, endSeq: 51 })
  assert.equal(r2.ok, false)
  assert.equal(r2.stage, 'no-pruner')
  assert.match(String(r2.error), /^\[stage:no-pruner\] /)
  assert.ok(String(r2.error).includes('module-registry'), 'tried 要带在正文里（排障用）')
  assert.equal(fx.appends.length, appends, '零写入')

  // ③ 挂上真 pruner → 成功帧（不带 error/stage）
  const p = mkPruner()
  p.__yqSeenSids.add(SID)
  current = p
  const r3 = await w.send('s3', { sessionId: SID, targetSession: SID, opId: 'stage-3', startSeq: 51, endSeq: 51 })
  assert.equal(r3.ok, true, JSON.stringify(r3))
  assert.equal(r3.data.framesAffected, 1)
  assert.equal(r3.stage, undefined, '成功帧不带 stage')
  assert.equal(r3.error, undefined, '成功帧不带 error')
  assert.ok(fx.appends.length > appends)

  // ④ 同 opId 换超集区间 → applyDrops 的 opid-reused 原样透传
  appends = fx.appends.length
  const r4 = await w.send('s4', { sessionId: SID, targetSession: SID, opId: 'stage-3', startSeq: 50, endSeq: 52 })
  assert.equal(r4.ok, false)
  assert.equal(r4.stage, 'opid-reused', 'applyDrops 的 code 必须原样带到线上')
  assert.match(String(r4.error), /^\[stage:opid-reused\] /)
  assert.equal(fx.appends.length, appends, '拒绝 = 零新增 append')

  // ⑤ 不明 action → bad-request
  const r5 = await w.send('s5', { sessionId: SID, opId: 'x', startSeq: 1, endSeq: 2 }, 'drop-all')
  assert.equal(r5.ok, false)
  assert.equal(r5.stage, 'bad-request')
  assert.equal(fx.appends.length, appends)

  // ⑥ 宿主侧抛超时 → 线上 error 带上 [stage:timeout]（桥自己不计时；这条是宿主抛上来的）
  current = { __yqSeenSids: new Set([SID]), applyDrops () { throw new Error('宿主侧执行超时 15000ms') } }
  const r6 = await w.send('s6', { sessionId: SID, targetSession: SID, opId: 'stage-6', startSeq: 1, endSeq: 2 })
  assert.equal(r6.ok, false)
  assert.equal(r6.stage, 'timeout')
  assert.match(String(r6.error), /^\[stage:timeout\] /)
  assert.equal(fx.appends.length, appends)
})

test('F1-3 线上开关关闭（prunerLive=false）：stage=unavailable / code=pruner\/disabled，一步不动', async (t) => {
  // ★ 2026-11-21 改写：prunerLive 现在**真的**是开关了（以前从没被读过）。
  //   关掉时的语义不再是「桩」—— 能力在，是被配置关了，所以：
  //     stage=unavailable（桶）、code=pruner/disabled（原因）、文案指向那个开关
  //   ★ 而且必须证明「一步都没动」：fx.appends 不许增长。
  mkTemp(t)
  const fx = mkSession(SID, [{ seq: 43, kind: 'result', callId: 'c43', text: BIG('C') }])
  const w = await wire(t, { prunerLive: false, getPruner: () => null, fx })
  const before = fx.appends.length
  const r = await w.send('s3', { sessionId: SID, targetSession: SID, opId: 'stage-3s', startSeq: 43, endSeq: 43 })
  assert.equal(r.ok, false)
  assert.equal(r.stage, 'unavailable')
  assert.equal(r.code, 'pruner/disabled')
  assert.match(String(r.error), /^\[stage:unavailable\] /)
  assert.match(String(r.error), /prunerLive=false/, '理由要能直接指到那个开关：' + r.error)
  assert.equal(fx.appends.length, before, '开关关着时一步都不许动')
})

// ───────────── 纯函数 + v4 闭环 ─────────────
test('F1-6 stage 映射：自报优先；stub / timeout / no-host / host-error 兜底', () => {
  const self = Object.assign(new Error('[stage:whatever] 正文'), { stage: 'no-pruner' })
  assert.equal(execStageOf(self), 'no-pruner', 'e.stage 优先于正文')

  assert.equal(execStageOf(new Error('超时 15000ms')), 'timeout')
  assert.equal(execStageOf(new Error('gateway timeout')), 'timeout')
  assert.equal(execStageOf(Object.assign(new Error('x'), { hint: 'stub_declared' })), 'stub')
  assert.equal(execStageOf(new Error('未实现（桩）：pruner 没有可执行的宿主实现')), 'stub')
  assert.equal(execStageOf(new Error('宿主不在: host-1')), 'no-host')
  assert.equal(execStageOf(new Error('随便什么错')), 'host-error')
  assert.equal(execStageOf(Object.assign(new Error('x'), { stage: 'BAD STAGE!' })), 'host-error', '非法 stage 词不采信')
})

test('F1-7 不泄露秘密：凭据键值对被隐去，正文单行且限长', () => {
  const e = new Error('请求失败 token=abc123 password: hunter2 api_key=sk-999\ncookie=sessionid=zzz')
  const f = execFailure(e)
  assert.equal(f.stage, 'host-error')
  assert.ok(!/abc123|hunter2|sk-999|sessionid=zzz/.test(f.error), '凭据值不许出现在回执里：' + f.error)
  assert.ok(f.error.includes('已隐去'))
  assert.ok(!/\n/.test(f.error), '必须单行')
  assert.ok(f.error.length <= 520, '限长 500 + 前缀')

  const long = execFailure(new Error('x'.repeat(5000)))
  assert.ok(long.error.length <= 520, '超长错误要截断：' + long.error.length)
})

test('F1-8 端到端：v4 真 stageOfError 认 [stage:no-target]（对照组：无前缀仍是 transport-error）', async (t) => {
  const v4 = await import(V4)
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yq-stage-v4-')))
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {} })

  const makeOrgan = (msg) => v4.createTargetedCleanup({
    control: {
      snapshot: () => [{ host: 'dsh', id: 'h1', caps: ['pruner'], stubs: [], connectedAt: '2026-11-11T00:00:00Z' }],
      canDo: () => [{ host: 'dsh', id: 'h1', caps: ['pruner'] }],
      exec: async () => { throw new Error(msg) },
    },
    autonomy: { config: {} },
    dataDir: tmp,
  })

  const withPrefix = await makeOrgan('[stage:no-target] 目标会话 session-nope 不在活的 agent 里').run({
    sessionId: 'session-nope', opId: 'v4-1', startSeq: 1, endSeq: 2,
  })
  assert.equal(withPrefix.ok, false)
  assert.equal(withPrefix.stage, 'no-target', 'v4 必须采用宿主自报的 stage（不是 transport-error）')

  const withoutPrefix = await makeOrgan('目标会话 session-nope 不在活的 agent 里').run({
    sessionId: 'session-nope', opId: 'v4-2', startSeq: 1, endSeq: 2,
  })
  assert.equal(withoutPrefix.stage, 'transport-error', '对照组：没有前缀时仍是旧口径')
})
