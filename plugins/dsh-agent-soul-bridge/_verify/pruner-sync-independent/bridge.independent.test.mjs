/**
 * 桥侧 pruner 薄适配 · 独立复核（2026-11-11，复核者未参与实现）
 * ==============================================================
 * 跑法（桥目录）：
 *   node --import "file:///D:/AI/dsh-tools/dsh-yanqing-pruner/test/register.mjs" \
 *        --test _verify/pruner-sync-independent/bridge.independent.test.mjs
 *
 * 只测三件事：
 *   ① 默认状态（prunerLive=false / stubCaps 仍含 pruner）与桩文案
 *   ② 三条取用通道各自成立（module-registry / ctx.toolResultPruner / agent.ctx）
 *   ③ 失败路径不伪成功、不动会话；回执翻给 v4 真判官能过
 * fixture 自己另造；写盘只在 temp 目录（realpath 断言）；生产回执按内容 hash 前后比对。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

import { DEFAULTS, describePrunerRequest, prunerRefusalMessage } from '../../index.js'
import { PRUNER_CAP, PRUNER_ACTION, resolvePruner, runTargetedCleanup } from '../../pruner-adapter.mjs'

const PRUNER = 'file:///D:/AI/dsh-tools/dsh-yanqing-pruner/index.js'
const V4 = 'file:///D:/AI/agent-soul/src/organs/cleanup.mjs'
const PROD_RCPT = 'D:/AI/yanqing-soul/30-状态/上下文修复回执.jsonl'
const SID = 'session-bridge-indep'

const prunerMod = await import(PRUNER)
const Yanqing = prunerMod.default
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
const prodHash = () => { try { const b = fs.readFileSync(PROD_RCPT); return b.length + '|' + sha(b) } catch { return 'missing' } }

function useTemp (t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yq-bridge-indep-')))
  assert.ok(dir.startsWith(fs.realpathSync(os.tmpdir())), '必须在 os.tmpdir() 真身里')
  prunerMod.__setFixPaths({ cmd: path.join(dir, 'cmd.jsonl'), rcpt: path.join(dir, 'rcpt.jsonl') })
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  return dir
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

const BIG = (tag) => 'HEAD|' + tag + '|' + 'x'.repeat(2500) + 'MID_' + tag + '|' + 'y'.repeat(2500) + '|TAIL'

function mkSession (id, items) {
  const events = new Map()
  const nodes = new Set()
  const appends = []
  let next = 7000
  for (const it of items) {
    const cid = it.callId || ('call-' + it.seq)
    if (it.kind === 'call') events.set(it.seq, { type: 'tool/call', seq: it.seq, data: { turn: 1, step: 1, callId: cid, name: 'bash', arguments: '{}' } })
    else events.set(it.seq, { type: 'tool/result', seq: it.seq, data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: cid }, toolCallId: cid, content: [{ type: 'tool-result', toolCallId: cid, content: [{ type: 'text', text: it.text }] }] } } })
    nodes.add(it.seq)
  }
  const session = {
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
  }
  const snap = () => JSON.stringify({ nodes: [...nodes].sort((a, b) => a - b), appends: appends.map((a) => a.seq) })
  return { session, events, nodes, appends, snap }
}

const mainFx = () => mkSession(SID, [
  { seq: 5, kind: 'result', callId: 'c5', text: BIG('OUT') },
  { seq: 61, kind: 'call', callId: 'c61' },
  { seq: 62, kind: 'result', callId: 'c61', text: BIG('IN1') },
  { seq: 63, kind: 'result', callId: 'c63', text: BIG('IN2') },
  { seq: 64, kind: 'result', callId: 'c64', text: BIG('OUT2') },
])
const ARGS = (extra = {}) => ({ sessionId: SID, targetSession: SID, opId: 'bridge-indep-1', startSeq: 61, endSeq: 63, ...extra })
const ctxOf = (session, extra = {}) => ({
  get (n) {
    if (n === 'agents') return { get: (id) => (id === session.id ? { session, ...extra } : undefined) }
    return extra.rootServices ? extra.rootServices[n] : undefined
  },
})

// ───────────────── B1 默认状态 ─────────────────
test('B1 默认接真：prunerLive=true；caps 举手、stubCaps 不再声明 pruner；拒绝文案只谈请求', () => {
  // ★ 2026-11-21 改写：原来守护「默认关着 + stubCaps 含 pruner + 桩文案」，
  //   这三样随 pruner 接真一起作废。现在守的是：
  //   · prunerLive 默认 **true**（而且它现在是**真开关** —— 以前从没被读过）
  //   · caps 仍举手（不许偷偷把能力摘掉）
  //   · stubCaps **不再**含 pruner（不再宣称是桩，hub 也就不会再拦）
  //   · 拒绝文案只在「参数不合法」时出现，且逐项列出缺什么
  assert.equal(DEFAULTS.prunerLive, true, 'pruner 已接真，默认执行')
  assert.ok(DEFAULTS.caps.includes('pruner'), 'caps 仍要举手')
  assert.ok(!DEFAULTS.stubCaps.includes('pruner'), 'stubCaps 里不该再有 pruner')
  assert.equal(PRUNER_CAP, 'pruner')
  assert.equal(PRUNER_ACTION, 'targeted-cleanup')
  const msg = prunerRefusalMessage(ARGS(), PRUNER_ACTION)
  assert.match(msg, /^请求不合法：pruner\/targeted-cleanup/, '起头要说清是请求问题：' + msg)
  assert.ok(!/未实现/.test(msg), '不该再出现「未实现」：' + msg)
  assert.match(msg, /请求会话=session-bridge-indep seq=61–63 opId=bridge-indep-1/, '要原样回显请求：' + msg)
  assert.ok(msg.split('\n').length === 1, 'v4 把 error 当一行读')
  // 请求不合法时也要原样说缺什么
  const bad = prunerRefusalMessage({ sessionId: SID, startSeq: 9 }, PRUNER_ACTION)
  assert.match(bad, /缺 args.opId/)
  assert.match(bad, /args\.endSeq 不是整数/)
})

// ───────────────── B2 真链路 ─────────────────
test('B2 通道 a（module-registry）+ 真 applyDrops：回执来自真实 surface 改写，v4 判官认', async (t) => {
  useTemp(t)
  const v4 = await import(V4)
  const fx = mainFx()
  const p = mkPruner()
  // ★ F5 修正后：getLivePruner 按会话**精确匹配** —— 实例必须「见过」目标会话才被认。
  //   生产里 __yqSeenSids 由 agent/pre-step 填；测试里显式补这一行（不靠「最后一个活实例」兜底）。
  p.__yqSeenSids.add(SID)
  prunerMod.__yqRegisterLiveForTest(p)
  t.after(() => prunerMod.__yqUnregisterLiveForTest(p))
  const ctx = ctxOf(fx.session)
  const before = prodHash()

  const got = await resolvePruner(ctx, SID, { loadPrunerModule: async () => prunerMod })
  assert.equal(got.pruner, p)
  assert.equal(got.how, 'module-registry')

  const data = await runTargetedCleanup({
    ctx, args: ARGS(), describe: describePrunerRequest,
    deps: { loadPrunerModule: async () => prunerMod },
  })
  assert.equal(data.targetSession, SID)
  assert.equal(data.opId, 'bridge-indep-1')
  assert.equal(data.startSeq, 61)
  assert.equal(data.endSeq, 63)
  assert.equal(data.framesAffected, 2, '62/63 落地（61 是 call，64 在区间外）')
  assert.equal(data.how, 'module-registry')
  assert.ok(!('bytesAffected' in data), '量不出就不带这个键')
  assert.ok(fx.nodes.has(61) && fx.nodes.has(64) && fx.nodes.has(5), '区间外与 call 帧都没动')
  assert.ok(!fx.nodes.has(62) && !fx.nodes.has(63))
  assert.equal(fx.appends.length, 4, '两帧 × (影子定价 + 替换)')
  assert.match(data.pointer, /^log:session-bridge-indep#seq=61$/)
  assert.equal(data.noMatch, false)
  assert.equal(data.replayed, false)
  assert.equal(prodHash(), before, '生产回执文件没被碰')

  const norm = v4.normalizeCleanupRequest({ sessionId: SID, targetSession: SID, opId: 'bridge-indep-1', startSeq: 61, endSeq: 63 }, {}, Date.now())
  const judged = v4.judgeCleanupReceipt({ data, request: norm.request })
  assert.equal(judged.ok, true, JSON.stringify(judged))
  assert.equal(judged.receipt.framesAffected, 2)
  assert.equal(judged.receipt.pointer, 'log:' + SID + '#seq=61')
  assert.equal(judged.receipt.bytesAffected, null)
  assert.equal(judged.receipt.atSource, 'host')
  assert.equal(judged.receipt.coverage, 'seq 61–63')
})

// ───────────────── B3 另外两条通道 ─────────────────
test('B3 通道 b/c 各自成立：ctx.toolResultPruner 与 agent.ctx 都能被找到并执行', async (t) => {
  useTemp(t)
  const mk = () => ({ applyDrops: ({ session, startSeq, endSeq, opId }) => ({ ok: true, v: 1, targetSession: session.id, opId, startSeq, endSeq, framesAffected: 0, bytesAffected: null, charsRemoved: 0, at: new Date().toISOString(), pointer: 'log:' + session.id + '#seq=' + startSeq, coverage: 'seq ' + startSeq + '–' + endSeq, entries: [], noMatch: true }) })

  const fx = mainFx()
  const direct = mk()
  const ctxB = { get: (n) => (n === 'toolResultPruner' ? direct : (n === 'agents' ? { get: () => ({ session: fx.session }) } : undefined)) }
  const rB = await resolvePruner(ctxB, SID, { loadPrunerModule: async () => null })
  assert.equal(rB.how, 'ctx.toolResultPruner')
  assert.equal(rB.pruner, direct)
  const dB = await runTargetedCleanup({ ctx: ctxB, args: ARGS({ opId: 'b3b' }), describe: describePrunerRequest, deps: { loadPrunerModule: async () => null } })
  assert.equal(dB.how, 'ctx.toolResultPruner')
  assert.equal(dB.opId, 'b3b')

  const child = mk()
  const fx2 = mainFx()
  const ctxC = {
    get (n) {
      if (n === 'agents') return { get: (id) => (id === fx2.session.id ? { session: fx2.session, ctx: { get: (s) => (s === 'toolResultPruner' ? child : undefined) } } : undefined) }
      return undefined
    },
  }
  const rC = await resolvePruner(ctxC, SID, { loadPrunerModule: async () => null })
  assert.equal(rC.how, 'agent.ctx')
  assert.deepEqual(rC.tried.map((x) => [x.how, x.got]), [['module-registry', false], ['ctx.toolResultPruner', false], ['agent.ctx', true]])
  const dC = await runTargetedCleanup({ ctx: ctxC, args: ARGS({ opId: 'b3c' }), describe: describePrunerRequest, deps: { loadPrunerModule: async () => null } })
  assert.equal(dC.how, 'agent.ctx')
  assert.equal(dC.framesAffected, 0)
})

// ───────────────── B4 拿不到 pruner ─────────────────
test('B4 三条通道全空 → 抛 no-pruner，会话一个字节没变（不自己拼 surface 改写）', async (t) => {
  useTemp(t)
  const fx = mainFx()
  const before = fx.snap()
  const ctx = ctxOf(fx.session)
  const r = await resolvePruner(ctx, SID, { loadPrunerModule: async () => null })
  assert.equal(r.pruner, null)
  assert.equal(r.how, null)
  assert.ok(r.tried.length >= 3, '三条通道都要留下 why：' + JSON.stringify(r.tried))
  assert.deepEqual(r.tried.map((x) => x.how), ['module-registry', 'ctx.toolResultPruner', 'agent.ctx', 'agent.session.ctx'])
  assert.ok(r.tried.every((x) => x.got === false))
  let err = null
  try {
    await runTargetedCleanup({ ctx, args: ARGS(), describe: describePrunerRequest, deps: { loadPrunerModule: async () => null } })
  } catch (e) { err = e }
  assert.ok(err)
  assert.equal(err.stage, 'no-pruner')
  assert.match(err.message, /不自己拼 surface 改写/)
  assert.equal(fx.snap(), before)
})

// ───────────────── B5 目标与请求不符 ─────────────────
test('B5 目标不在活 agent 里 / session.id 不符 → no-target / target-mismatch，零写入', async (t) => {
  useTemp(t)
  const fx = mainFx()
  const before = fx.snap()
  const deps = { loadPrunerModule: async () => prunerMod }

  let e1 = null
  try { await runTargetedCleanup({ ctx: ctxOf(fx.session), args: ARGS({ sessionId: 'session-nowhere', targetSession: 'session-nowhere', opId: 'o1' }), describe: describePrunerRequest, deps }) } catch (e) { e1 = e }
  assert.equal(e1.stage, 'no-target')

  const wrong = mkSession('session-other-id', [{ seq: 61, kind: 'result', callId: 'c', text: BIG('X') }])
  // agents.get(SID) 故意回一个 id 不符的 agent —— 适配层必须自己再核一次 session.id
  const ctxWrong = { get: (n) => (n === 'agents' ? { get: () => ({ session: wrong.session }) } : undefined) }
  let e2 = null
  try { await runTargetedCleanup({ ctx: ctxWrong, args: ARGS({ opId: 'o2' }), describe: describePrunerRequest, deps }) } catch (e) { e2 = e }
  assert.equal(e2.stage, 'target-mismatch')
  assert.match(e2.message, /session\.id 是 session-other-id/)

  // sessionId 与 targetSession 不一致 → 在解析阶段就拒
  let e3 = null
  try { await runTargetedCleanup({ ctx: ctxOf(fx.session), args: ARGS({ targetSession: 'x-other', opId: 'o3' }), describe: describePrunerRequest, deps }) } catch (e) { e3 = e }
  assert.equal(e3.stage, 'bad-request')
  assert.equal(fx.snap(), before)
})

// ───────────────── B6 applyDrops 自己失败 ─────────────────
test('B6 applyDrops 回 ok:false → 原样带出 code，不包装成成功', async (t) => {
  useTemp(t)
  const fx = mainFx()
  const before = fx.snap()
  for (const code of ['opid-reused', 'prune-threw', 'target-mismatch']) {
    const fake = { applyDrops: () => ({ ok: false, code, reason: '测试注入：' + code }) }
    let err = null
    try {
      await runTargetedCleanup({ ctx: ctxOf(fx.session), args: ARGS({ opId: 'b6-' + code }), describe: describePrunerRequest, deps: { loadPrunerModule: async () => ({ getLivePruner: () => fake }) } })
    } catch (e) { err = e }
    assert.equal(err.stage, code)
    assert.match(err.message, new RegExp(code))
  }
  // 连抛错、返回 null 这种也要算失败
  for (const fake of [{ applyDrops: () => null }, { applyDrops: () => ({}) }]) {
    let err = null
    try { await runTargetedCleanup({ ctx: ctxOf(fx.session), args: ARGS({ opId: 'b6x' }), describe: describePrunerRequest, deps: { loadPrunerModule: async () => ({ getLivePruner: () => fake }) } }) } catch (e) { err = e }
    assert.equal(err.stage, 'apply-failed')
  }
  assert.equal(fx.snap(), before)
})

// ───────────────── B7 真链路 + 生产文件 ─────────────────
test('B7 真链路跑两轮：生产回执内容 hash 不变；活实例表摘干净', async (t) => {
  const before = prodHash()
  useTemp(t)
  const fx = mainFx()
  const p = mkPruner()
  // ★ F5 修正后：getLivePruner 按会话**精确匹配** —— 实例必须「见过」目标会话才被认。
  //   生产里 __yqSeenSids 由 agent/pre-step 填；测试里显式补这一行（不靠「最后一个活实例」兜底）。
  p.__yqSeenSids.add(SID)
  prunerMod.__yqRegisterLiveForTest(p)
  try {
    const d1 = await runTargetedCleanup({ ctx: ctxOf(fx.session), args: ARGS({ opId: 'b7-1' }), describe: describePrunerRequest, deps: { loadPrunerModule: async () => prunerMod } })
    assert.equal(d1.framesAffected, 2)
    const d2 = await runTargetedCleanup({ ctx: ctxOf(fx.session), args: ARGS({ startSeq: 64, endSeq: 64, opId: 'b7-2' }), describe: describePrunerRequest, deps: { loadPrunerModule: async () => prunerMod } })
    assert.equal(d2.framesAffected, 1, '第二段只有一帧')
    assert.equal(d2.pointer, 'log:' + SID + '#seq=64')
    // 重放：同 opId 再来一次 → 帧数还原、不再 append
    const n = fx.appends.length
    const d3 = await runTargetedCleanup({ ctx: ctxOf(fx.session), args: ARGS({ startSeq: 64, endSeq: 64, opId: 'b7-2' }), describe: describePrunerRequest, deps: { loadPrunerModule: async () => prunerMod } })
    assert.equal(d3.replayed, true)
    assert.equal(d3.framesAffected, 1)
    assert.equal(fx.appends.length, n)
  } finally { prunerMod.__yqUnregisterLiveForTest(p) }
  assert.equal(prunerMod.livePrunerCount(), 0)
  assert.equal(prodHash(), before)
})
