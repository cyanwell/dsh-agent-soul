/**
 * pruner 薄适配 · 证据测试（2026-11-11）
 * =====================================
 * 跑法（桥目录）：
 *   node --import D:/AI/dsh-tools/dsh-yanqing-pruner/test/register.mjs \
 *        --test _verify/pruner-sync/adapter.test.mjs
 *
 * 三层证据：
 *   ① 适配层自己的行为（解析/找会话/找 pruner/翻译回执）
 *   ② 用**真** dsh-yanqing-pruner 实例跑一遍，回执来自真实 surface 改写
 *   ③ 把回执喂给 **v4 的真判官**（agent-soul/src/organs/cleanup.mjs 的
 *      normalizeCleanupRequest + judgeCleanupReceipt），看它认不认
 * 一切写盘指向临时目录；生产回执文件用 stat 前后不变证明没被碰。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import DEFAULTS_HOLDER, { prunerRefusalMessage, describePrunerRequest, DEFAULTS } from '../../index.js'
import { resolvePruner, runTargetedCleanup } from '../../pruner-adapter.mjs'

const PRUNER_SRC = 'file:///D:/AI/dsh-tools/dsh-yanqing-pruner/index.js'
const V4_CLEANUP = 'file:///D:/AI/agent-soul/src/organs/cleanup.mjs'
const PROD_RCPT = 'D:/AI/yanqing-soul/30-状态/上下文修复回执.jsonl'
const SID = 'session-bridge-0001'

const prunerMod = await import(PRUNER_SRC)
const v4 = await import(V4_CLEANUP)
const Drops = prunerMod.default

function useTemp (t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'yq-bridge-')))
  assert.ok(dir.startsWith(fs.realpathSync(os.tmpdir())), '必须在 os.tmpdir() 里')
  prunerMod.__setFixPaths({ cmd: path.join(dir, 'cmd.jsonl'), rcpt: path.join(dir, 'rcpt.jsonl') })
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  return dir
}

const prodStamp = (f) => { try { const s = fs.statSync(f); return s.size + '@' + s.mtimeMs } catch { return 'missing' } }

function makePruner () {
  const p = Object.create(Drops.prototype)
  p.config = Object.freeze({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
  p.ctx = { tokenMeter: { estimateMessage: () => 1 } }
  p.__yqQueue = null; p.__yqCursor = 0; p.__yqSid = ''; p.__yqForced = null
  p.__yqForcedKeys = null; p.__yqPendingPlan = null; p.__yqBlocksBySeq = null
  p.__yqAllowed = null; p.__yqSeenSids = new Set()
  p.__yqLastTurn = new Map()
  p.__yqAutoCfg = { minPrunableChars: 60000, cooldownTurns: 20 }
  p.__yqStats = { calls: 0, triggered: 0, lastPrunable: 0, lastTurn: 0, lastSid: '', started: '', updated: '' }
  p.__yqFlushStats = () => {}
  return p
}

const BIG = (tag) => 'HEAD|' + tag + '|' + 'x'.repeat(3000) + 'MID' + 'y'.repeat(3000) + '|TAIL'

function makeSession (id, items, turn = 1) {
  const events = new Map()
  const nodes = new Set()
  const log = []
  let next = 9000
  for (const it of items) {
    const callId = it.callId
    if (it.kind === 'call') {
      events.set(it.seq, { type: 'tool/call', seq: it.seq, data: { turn, step: 1, callId, name: 'bash', arguments: '{}' } })
    } else {
      events.set(it.seq, {
        type: 'tool/result', seq: it.seq,
        data: { turn, step: 1, message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: it.text }] }] } },
      })
    }
    nodes.add(it.seq)
  }
  const session = {
    id, turn, surface: { nodes },
    eventAt: (s) => events.get(Number(s)),
    append (type, data, opts) {
      const seq = next; next += 1
      log.push({ type, seq, opts: opts || null })
      if (opts && opts.surfaceOp && opts.surfaceOp.op === 'replace') {
        for (let s = Number(opts.surfaceOp.startSeq); s <= Number(opts.surfaceOp.endSeq); s += 1) nodes.delete(s)
      }
      events.set(seq, { type, seq, data })
      if (type !== 'compaction/prune') nodes.add(seq)
      return { seq }
    },
  }
  const snap = () => JSON.stringify({ nodes: [...nodes].sort((a, b) => a - b), log: log.map((l) => [l.type, l.seq]) })
  return { session, log, events, nodes, snap }
}

const ctxWith = (agent) => ({
  get (n) {
    if (n === 'agents') return { get: (id) => (id === agent.session.id ? agent : undefined) }
    return undefined
  },
})

const args = (extra = {}) => ({ sessionId: SID, targetSession: SID, opId: 'clean-b1', startSeq: 21, endSeq: 22, ...extra })

// ───────────────── 1. 开关默认关着（与 11-10 行为一致） ─────────────────
test('① prunerLive 默认 true 且不再是桩；请求不合法时的拒绝仍原样回显请求', () => {
  // ★ 2026-11-21 改写：这条原来断言「默认关着、stubCaps 含 pruner、文案以『未实现（桩）』开头」——
  //   那三样都已经作废（pruner 接真了）。现在守的是：
  //   · prunerLive 默认 **true**，而且它是**真开关**（2026-11-21 之前它从没被读过）
  //   · stubCaps 里**没有** pruner（不再宣称是桩）
  //   · 拒绝文案换成「请求不合法：」，并且照样把请求原样回显
  assert.equal(DEFAULTS.prunerLive, true, 'pruner 已接真，默认执行')
  assert.ok(!DEFAULTS.stubCaps.includes('pruner'), 'stubCaps 里不该再有 pruner')
  const msg = prunerRefusalMessage(args(), 'targeted-cleanup')
  assert.match(msg, /^请求不合法：/, '拒绝文案不再是桩文案')
  assert.ok(!/未实现/.test(msg), '不该再出现「未实现」')
  assert.match(msg, /opId=clean-b1/, '拒绝时仍原样回显请求')
})

// ───────────────── 2. 真 pruner 走通：回执来自真实改写 ─────────────────
test('② 适配 + 真 applyDrops：回执来自真实 surface 改写，且过 v4 真判官', async (t) => {
  useTemp(t)
  const fx = makeSession(SID, [
    { seq: 20, kind: 'call', callId: 'call-20' },
    { seq: 21, kind: 'result', callId: 'call-20', text: BIG('A') },
    { seq: 22, kind: 'result', callId: 'call-22', text: BIG('B') },
    { seq: 23, kind: 'result', callId: 'call-23', text: BIG('C') },
  ])
  const p = makePruner()
  // ★ F5 修正后：getLivePruner 按会话**精确匹配** —— 实例必须「见过」目标会话才被认。
  //   生产里 __yqSeenSids 由 agent/pre-step 填；测试里显式补这一行（不靠「最后一个活实例」兜底）。
  p.__yqSeenSids.add(SID)
  prunerMod.__yqRegisterLiveForTest(p)
  t.after(() => prunerMod.__yqUnregisterLiveForTest(p))

  const ctx = ctxWith({ session: fx.session })
  const got = await resolvePruner(ctx, SID, { loadPrunerModule: async () => prunerMod })
  assert.equal(got.pruner, p)
  assert.equal(got.how, 'module-registry')

  const prodBefore = prodStamp(PROD_RCPT)
  const data = await runTargetedCleanup({
    ctx, args: args(), describe: describePrunerRequest,
    deps: { loadPrunerModule: async () => prunerMod },
  })

  assert.equal(data.targetSession, SID)
  assert.equal(data.opId, 'clean-b1')
  assert.equal(data.startSeq, 21)
  assert.equal(data.endSeq, 22, 'endSeq 原样（不替调用方对齐）')
  assert.equal(data.framesAffected, 2)
  assert.equal(data.how, 'module-registry')
  assert.ok(!('bytesAffected' in data), '量不出就不给这个键，不补 0')
  assert.ok(!fx.nodes.has(21) && !fx.nodes.has(22), '两帧真的被替换了')
  assert.ok(fx.nodes.has(23), '区间外的没动')
  assert.ok(fx.log.length === 4, 'compaction/prune × 2 + tool/result × 2')
  assert.equal(prodStamp(PROD_RCPT), prodBefore, '生产回执文件没被碰')

  // ★ v4 的真判官认不认这条回执
  const norm = v4.normalizeCleanupRequest({ sessionId: SID, targetSession: SID, opId: 'clean-b1', startSeq: 21, endSeq: 22 }, {}, Date.now())
  assert.equal(norm.ok, true)
  const judged = v4.judgeCleanupReceipt({ data, request: norm.request })
  assert.equal(judged.ok, true, JSON.stringify(judged))
  assert.equal(judged.receipt.framesAffected, 2)
  assert.equal(judged.receipt.pointer, 'log:' + SID + '#seq=21')
  assert.equal(judged.receipt.bytesAffected, null)
  assert.equal(judged.receipt.atSource, 'host', 'at 来自宿主回执')
})

test('③ framesAffected=0（区间内没有可剪的）→ v4 判官**判失败**（0 帧不算清理成功）', async (t) => {
  useTemp(t)
  const fx = makeSession(SID, [{ seq: 40, kind: 'call', callId: 'call-40' }])
  const p = makePruner()
  // ★ F5 修正后：getLivePruner 按会话**精确匹配** —— 实例必须「见过」目标会话才被认。
  //   生产里 __yqSeenSids 由 agent/pre-step 填；测试里显式补这一行（不靠「最后一个活实例」兜底）。
  p.__yqSeenSids.add(SID)
  prunerMod.__yqRegisterLiveForTest(p)
  t.after(() => prunerMod.__yqUnregisterLiveForTest(p))
  const ctx = ctxWith({ session: fx.session })
  const before = fx.snap()
  const data = await runTargetedCleanup({
    ctx, args: args({ startSeq: 40, endSeq: 40, opId: 'clean-b3' }), describe: describePrunerRequest,
    deps: { loadPrunerModule: async () => prunerMod },
  })
  assert.equal(data.framesAffected, 0)
  assert.equal(data.noMatch, true)
  assert.equal(fx.snap(), before, '什么都没动')
  const norm = v4.normalizeCleanupRequest({ sessionId: SID, targetSession: SID, opId: 'clean-b3', startSeq: 40, endSeq: 40 }, {}, Date.now())
  const judged = v4.judgeCleanupReceipt({ data, request: norm.request })
  // ★★★ 2026-11-21 改写：原来断言 judged.ok===true —— 那守护的是 2026-11-11 的旧结论，
  //   而 v4 在 **2026-11-17** 就把它推翻了（cleanup.mjs:226-233）：
  //     「影响 0 帧不算清理成功。原来 0 能一路过闸 —— 回执里 framesAffected:0、判 ok:true、
  //      落一条成功记录、面板写『已清 1 段』。而上下文一个字都没变。」
  //   所以正确的守护是：**0 帧必须被判失败**，理由要能指到 nothing-cleaned。
  assert.equal(judged.ok, false, '0 帧不许被判成功')
  // ★ 判官的失败形状是 { ok:false, stage, reason } —— 字段叫 stage，不是 code。
  assert.equal(judged.stage, 'nothing-cleaned', '失败理由必须是 nothing-cleaned，实际=' + JSON.stringify(judged))
  assert.match(String(judged.reason || ''), /0 帧/, '理由要说清为什么（0 帧）：' + JSON.stringify(judged))
})

// ───────────────── 3. 失败路径：不伪成功、不动文件 ─────────────────
test('④ 够不到 pruner → 抛 no-pruner，会话一个字节没变（不自己拼 surface 改写）', async (t) => {
  useTemp(t)
  const fx = makeSession(SID, [{ seq: 50, kind: 'result', callId: 'call-50', text: BIG('D') }])
  const ctx = { get: (n) => (n === 'agents' ? { get: () => ({ session: fx.session }) } : undefined) }
  const before = fx.snap()
  let err = null
  try {
    await runTargetedCleanup({
      ctx, args: args({ startSeq: 50, endSeq: 50, opId: 'clean-b4' }), describe: describePrunerRequest,
      deps: { loadPrunerModule: async () => null },
    })
  } catch (e) { err = e }
  assert.ok(err, '必须抛错')
  assert.equal(err.stage, 'no-pruner')
  assert.match(err.message, /不自己拼 surface 改写/)
  assert.equal(fx.snap(), before)
})

test('⑤ 请求不合法 / 目标不在活的 agent 里 / session.id 不符 —— 三条 stage 分明', async (t) => {
  useTemp(t)
  const fx = makeSession(SID, [{ seq: 60, kind: 'result', callId: 'call-60', text: BIG('E') }])
  const ctx = ctxWith({ session: fx.session })
  const deps = { loadPrunerModule: async () => prunerMod }

  let e1 = null
  try { await runTargetedCleanup({ ctx, args: { sessionId: SID, startSeq: 1 }, describe: describePrunerRequest, deps }) } catch (e) { e1 = e }
  assert.equal(e1.stage, 'bad-request')
  assert.match(e1.message, /opId/)

  let e2 = null
  try {
    await runTargetedCleanup({ ctx, args: args({ sessionId: 'session-other', targetSession: 'session-other', opId: 'x1' }), describe: describePrunerRequest, deps })
  } catch (e) { e2 = e }
  assert.equal(e2.stage, 'no-target')

  const wrong = makeSession('session-different', [{ seq: 61, kind: 'result', callId: 'call-61', text: BIG('F') }])
  const ctx2 = { get: (n) => (n === 'agents' ? { get: () => ({ session: wrong.session }) } : undefined) }
  let e3 = null
  try { await runTargetedCleanup({ ctx: ctx2, args: args({ startSeq: 61, endSeq: 61, opId: 'x2' }), describe: describePrunerRequest, deps }) } catch (e) { e3 = e }
  assert.equal(e3.stage, 'target-mismatch')
  assert.equal(fx.nodes.has(60), true, '整轮下来目标会话没被动过')
})

test('⑥ applyDrops 自己失败（如 opid-reused）→ 原样带出 code，不包装成成功', async (t) => {
  useTemp(t)
  const fx = makeSession(SID, [{ seq: 70, kind: 'result', callId: 'call-70', text: BIG('G') }])
  const fake = { applyDrops: () => ({ ok: false, code: 'opid-reused', reason: '测试：这个 opId 用过了' }) }
  const mod = { getLivePruner: () => fake, livePrunerCount: () => 1 }
  const ctx = ctxWith({ session: fx.session })
  let err = null
  try {
    await runTargetedCleanup({ ctx, args: args({ startSeq: 70, endSeq: 70, opId: 'clean-b6' }), describe: describePrunerRequest, deps: { loadPrunerModule: async () => mod } })
  } catch (e) { err = e }
  assert.equal(err.stage, 'opid-reused')
  assert.match(err.message, /这个 opId 用过了/)
  assert.equal(fx.nodes.has(70), true)
})

test('⑦ bytesAffected：宿主给了整数才带，给了 null 就整个键不出现', async (t) => {
  useTemp(t)
  const fx = makeSession(SID, [{ seq: 80, kind: 'result', callId: 'call-80', text: BIG('H') }])
  const ctx = ctxWith({ session: fx.session })
  const base = { ok: true, targetSession: SID, opId: 'clean-b7', startSeq: 80, endSeq: 80, framesAffected: 1, at: new Date().toISOString(), pointer: 'log:' + SID + '#seq=80', coverage: 'seq 80–80', charsRemoved: 10 }
  const withBytes = { applyDrops: () => ({ ...base, bytesAffected: 1234 }) }
  const noBytes = { applyDrops: () => ({ ...base, bytesAffected: null }) }
  const d1 = await runTargetedCleanup({ ctx, args: args({ startSeq: 80, endSeq: 80, opId: 'clean-b7' }), describe: describePrunerRequest, deps: { loadPrunerModule: async () => ({ getLivePruner: () => withBytes }) } })
  assert.equal(d1.bytesAffected, 1234)
  const d2 = await runTargetedCleanup({ ctx, args: args({ startSeq: 80, endSeq: 80, opId: 'clean-b7' }), describe: describePrunerRequest, deps: { loadPrunerModule: async () => ({ getLivePruner: () => noBytes }) } })
  assert.ok(!('bytesAffected' in d2), 'null 就不出现，不补 0')
})

test('⑧ 拒绝文案不再是桩：说「请求不合法」并逐项列出缺什么，且回显请求', () => {
  // ★ 2026-11-21 改写：原来断言文案以「未实现（桩）：」开头、并提到 hello.meta.stubs。
  //   那套措辞随「pruner 接真」一起作废了 —— 现在请求不合法就是请求不合法，
  //   不该拿「未实现」去盖住一个参数错误（那会让人以为能力没做）。
  const msg = prunerRefusalMessage({ sessionId: SID, startSeq: 5, endSeq: 9, opId: 'o9' }, 'targeted-cleanup')
  assert.match(msg, /^请求不合法：pruner\/targeted-cleanup/, '起头要说清是请求问题：' + msg)
  assert.ok(!/未实现/.test(msg), '不该再出现「未实现」：' + msg)
  assert.ok(!/hello\.meta\.stubs/.test(msg), '不该再让人去看 stubs（它已经不是桩了）：' + msg)
  assert.match(msg, /请求会话=session-bridge-0001 seq=5–9 opId=o9/, '仍要原样回显请求：' + msg)
  // 这条请求本身缺 targetSession 之外的东西吗？不缺 —— 所以它应当被判定为**合法**。
  // 用一个真不合法的请求，验「缺什么」被逐项列出：
  const bad = prunerRefusalMessage({ startSeq: 5, endSeq: 9 }, 'targeted-cleanup')
  assert.match(bad, /sessionId/, '缺 sessionId 要说出来：' + bad)
  assert.match(bad, /opId/, '缺 opId 要说出来：' + bad)
})

// ─────── 2026-11-21 新增：dryRun 必须被转发，回执必须能自证「为什么是 0」 ───────
//   起因（真实事故，两次）：
//   ① 我发 dryRun:true 想「只解析」，适配器只传五个字段，dryRun 被吞 → **真的动了刀**。
//   ② framesAffected=0 / noMatch=true 时，回执里没有 resolved，调用方分不出
//      「区间里真的没有 tool/result」和「挑错了 seq」。跑去诊断三次才看清。
//   判据：dryRun 一传到底；诊断字段原样透出。
test('⑦ dryRun 必须转发（否则「只解析」变成真动刀）', async (t) => {
  useTemp(t)
  const fx = makeSession(SID, [
    { seq: 20, kind: 'call', callId: 'call-20' },
    { seq: 21, kind: 'result', callId: 'call-20', text: BIG('A') },
  ])
  const p = makePruner()
  p.__yqSeenSids.add(SID)
  prunerMod.__yqRegisterLiveForTest(p)
  t.after(() => prunerMod.__yqUnregisterLiveForTest(p))

  const before = fx.snap()
  const data = await runTargetedCleanup({
    ctx: ctxWith({ session: fx.session }),
    args: args({ startSeq: 21, endSeq: 21, dryRun: true }),
    describe: describePrunerRequest,
    deps: { loadPrunerModule: async () => prunerMod },
  })
  assert.equal(fx.snap(), before, 'dryRun 竟然改了 surface —— 参数被适配器吞了')
  assert.equal(data.dryRun, true, '回执必须标出这次是 dryRun')
  assert.ok('wouldAffect' in data, 'dryRun 要给出「本会动几帧」')
  assert.equal(data.framesAffected, 0, 'dryRun 的 framesAffected 恒 0（别拿它当回执用）')
})

test('⑧ 回执必须带诊断字段：0 帧要能自证原因', async (t) => {
  useTemp(t)
  // seq 9999 不在 surface 上 —— 这是「挑错了 seq」，不是「区间里没有 tool/result」
  const fx = makeSession(SID, [
    { seq: 20, kind: 'call', callId: 'call-20' },
    { seq: 21, kind: 'result', callId: 'call-20', text: BIG('A') },
  ])
  const p = makePruner()
  p.__yqSeenSids.add(SID)
  prunerMod.__yqRegisterLiveForTest(p)
  t.after(() => prunerMod.__yqUnregisterLiveForTest(p))

  const data = await runTargetedCleanup({
    ctx: ctxWith({ session: fx.session }),
    args: args({ startSeq: 9999, endSeq: 9999 }),
    describe: describePrunerRequest,
    deps: { loadPrunerModule: async () => prunerMod },
  })
  assert.equal(data.framesAffected, 0)
  assert.ok(data.resolved, '缺 resolved —— 调用方分不出「真的没有」和「挑错 seq」')
  assert.ok(Number.isInteger(data.resolved.surfaceSize), '要给出 surface 有多大')
  assert.equal(data.resolved.inRange, 0, '这个 seq 不在 surface 上')
})

test('⑨ 回执必须带 diagnosis：每个 seq 为什么不合格要写清', async (tt) => {
  useTemp(tt)
  const fx = makeSession(SID, [
    { seq: 20, kind: 'call', callId: 'call-20' },
    { seq: 21, kind: 'result', callId: 'call-20', text: BIG('A') },
  ])
  const p = makePruner()
  p.__yqSeenSids.add(SID)
  prunerMod.__yqRegisterLiveForTest(p)
  tt.after(() => prunerMod.__yqUnregisterLiveForTest(p))

  // 9998 不在 surface 上；21 在且合格
  const data = await runTargetedCleanup({
    ctx: ctxWith({ session: fx.session }),
    args: args({ startSeq: 21, endSeq: 9998, opId: 'diag-1' }),
    describe: describePrunerRequest,
    deps: { loadPrunerModule: async () => prunerMod },
  })
  assert.ok(data.diagnosis, '缺 diagnosis —— 0 帧时调用方只能靠猜')
  assert.equal(data.diagnosis.surfaceSize, 2, '要给出 surface 有多大')
  const bySeq = new Map(data.diagnosis.nodes.map((n) => [n.seq, n]))
  assert.equal(bySeq.get(21).onSurface, true)
  assert.equal(bySeq.get(21).why, 'ok')
  assert.equal(bySeq.get(9998).onSurface, false, '不在 surface 上必须标出来')
  // ★ 9998 这个 fixture 里连事件都没有 → no-event；若「有事件但不在 surface 上」→ not-on-surface。
  //   两者必须**分得开**：前者是挑错了 seq，后者是挑了一条已剪过的。混成一个码就又要靠猜。
  assert.ok(['no-event', 'not-on-surface'].includes(bySeq.get(9998).why), '实际 ' + bySeq.get(9998).why)
})

test('⑩ context/candidates 与 pruner 必须用同一套判据（surface.nodes）', async () => {
  const { makeContextSurgeon } = await import('../../context-surgeon.mjs')
  const fx = makeSession(SID, [
    { seq: 20, kind: 'call', callId: 'call-20' },
    { seq: 21, kind: 'result', callId: 'call-20', text: BIG('A') },
    { seq: 22, kind: 'result', callId: 'call-22', text: BIG('B') },
  ])
  // ★ 把 22 从 surface 上摘掉，但**事件仍留在 events 里** —— 这正是线上的真实情形
  fx.nodes.delete(22)
  const agent = { session: fx.session }
  const surg = makeContextSurgeon(agent, SID)
  assert.equal(surg.ok, true)
  const got = surg.candidates(10)
  assert.equal(got.ok, true)
  const seqs = got.items.map((x) => x.seq)
  assert.ok(!seqs.includes(22), '★ 22 不在 surface 上，不该被列为候选 —— 列了 pruner 也剪不动（线上 14 个全 0 帧就是这么来的）')
  assert.ok(seqs.includes(21), '在 surface 上的要列出来')
  assert.ok(got.items.every((x) => x.onSurface === true), '候选必须全是在 surface 上的')
  // 长度要按两层形状算出来，不是恒 0（旧实现只读一层）
  const item = got.items.find((x) => x.seq === 21)
  assert.ok(item.len > 1000, 'len 恒 0 等于没排序，实际 ' + item.len)
})

test('⑪ candidates 的 len 必须按真实形状算出来（不能恒 0）', async () => {
  // ★ 第五处两层假设：context-surgeon 算长度时读 content[0].content（两层），
  //   真实帧是一层 → len 恒 0 → "沙袋优先"排序等于没排，而且看不出错。
  const { makeContextSurgeon } = await import('../../context-surgeon.mjs')
  const fx = makeSession(SID, [
    { seq: 20, kind: 'call', callId: 'call-20' },
    { seq: 21, kind: 'result', callId: 'call-20', text: BIG('A') },
  ])
  const surg = makeContextSurgeon({ session: fx.session }, SID)
  const got = surg.candidates(10)
  assert.equal(got.ok, true)
  const item = got.items.find((x) => x.seq === 21)
  assert.ok(item, '在 surface 上的必须列出来')
  assert.ok(item.len > 1000, '★ len 恒 0 等于没排序，实际 ' + item.len)
})

test('⑫ 已带门牌的节点不能再被列为候选（hasPruneMarkerLike 一度恒 false）', async () => {
  // ★ 第六处两层假设：hasPruneMarkerLike 只读 content[0].content（两层），
  //   一层帧时 blocks 落到 d.content（undefined）→ **恒返回 false** →
  //   已剪过的节点（正文里明明有门牌）会**被反复列为候选**，
  //   而真拿去剪时 pruner 会以 already-pruned 跳过。
  const { makeContextSurgeon } = await import('../../context-surgeon.mjs')
  const gated = 'HEAD…\n[pruned] 原文可取回：log:' + SID + '#seq=99\n' + 'TAIL'
  const fx = makeSession(SID, [
    { seq: 21, kind: 'result', callId: 'c21', text: BIG('A') },
    { seq: 22, kind: 'result', callId: 'c22', text: gated },
  ])
  const surg = makeContextSurgeon({ session: fx.session }, SID)
  const got = surg.candidates(10)
  const seqs = got.items.map((x) => x.seq)
  assert.ok(seqs.includes(21), '没门牌的应该列出来')
  assert.ok(!seqs.includes(22), '★ 带门牌的 22 不该被列为候选 —— 列了剪也会被 already-pruned 跳过')
})

test('⑬ diagnosis.hasMarker 不能与 pruner 的 already-pruned 打架（第七处：传错参数类型）', async (tt) => {
  useTemp(tt)
  // ★ 2026-11-21 实测矛盾现场：seq 84649 的 diagnosis.hasMarker=false，
  //   而同一次调用的 skipped 说 "already-pruned"。
  //   根因：adapter 把 **event 对象** 传给了只收 **string** 的 hasPruneMarker ——
  //   它第一行就是 `if (typeof text !== 'string') return false` → **恒 false**。
  //   ★ 判据：同一个谓词在两个地方各写一遍，参数类型一定会有人传错。
  const marker = '\n\n[... 中间被裁 · 原文在 append-only 会话日志 seq 21，取回：log:s-x#seq=21 ...]\n\n'
  const fx = makeSession(SID, [
    { seq: 20, kind: 'call', callId: 'call-20' },
    { seq: 21, kind: 'result', callId: 'call-20', text: BIG('A') + marker + 'TAIL' },
  ])
  const p = makePruner()
  p.__yqSeenSids.add(SID)
  prunerMod.__yqRegisterLiveForTest(p)
  tt.after(() => prunerMod.__yqUnregisterLiveForTest(p))

  const data = await runTargetedCleanup({
    ctx: ctxWith({ session: fx.session }),
    args: args({ startSeq: 21, endSeq: 21, opId: 'marker-1' }),
    describe: describePrunerRequest,
    deps: { loadPrunerModule: async () => prunerMod },
  })
  const n21 = data.diagnosis.nodes.find((n) => n.seq === 21)
  assert.ok(n21, 'diagnosis 里必须列出 21')
  assert.equal(n21.hasMarker, true,
    '★ 带门牌的那条必须报 true —— 报 false 就是 adapter 又传错了类型')
  // ★ 而且它必须与 pruner 自己的判定一致：那条应当被判 already-pruned，不是被剪
  const sk = (data.skipped || []).find((s) => s.seq === 21)
  assert.ok(sk && sk.code === 'already-pruned',
    'pruner 必须自己说 already-pruned（got ' + JSON.stringify(data.skipped) + '）')
})
